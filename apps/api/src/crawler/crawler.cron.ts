import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZTTeamFetcherService } from './fetcher.service';
import { ZTTeamWordpressService } from '../wordpress/wordpress.service';
import { ZTTeamCrawlerService } from './crawler.service';
import Parser from 'rss-parser';
import { TelegramService, ztteam_extractErrorMessage } from '../telegram/telegram.service';

@Injectable()
export class ZTTeamCrawlerCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(ZTTeamCrawlerCron.name);
  private rssParser: Parser;
  private isRunning = false;
  private lastStartedAt = 0;
  private readonly MAX_CRAWL_LOCK_DURATION_MS = 15 * 60 * 1000; /** 15 phút tối đa */

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcherService: ZTTeamFetcherService,
    private readonly wordpressService: ZTTeamWordpressService,
    private readonly telegramService: TelegramService,
    private readonly crawlerService: ZTTeamCrawlerService,
  ) {
    this.rssParser = new Parser({
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });
  }

  onApplicationBootstrap() {
    if (process.env.ENABLE_AUTO_CRON === 'false') {
      this.logger.log('Auto-Crawler Cron is disabled via ENABLE_AUTO_CRON=false');
      return;
    }
    this.logger.log('Application started, triggering initial crawler run...');
    this.ztteam_handleCron();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async ztteam_handleCron() {
    if (process.env.ENABLE_AUTO_CRON === 'false') {
      return;
    }
    if (this.isRunning) {
      const runningDuration = Date.now() - this.lastStartedAt;
      if (runningDuration > this.MAX_CRAWL_LOCK_DURATION_MS) {
        this.logger.error(`[WATCHDOG RECOVERY] Auto-Crawler Cron has been running for ${Math.round(runningDuration / 60000)} mins (limit exceeded). Force releasing lock to resume automated operations.`);
        this.isRunning = false;
        this.telegramService.ztteam_sendMessage(
          `🚨 <b>[AUTO-CRAWLER WATCHDOG RESET]</b>\n` +
          `Hệ thống phát hiện tiến trình cào bài bị kẹt lock quá 15 phút (có khả năng do server nguồn giữ socket treo).\n` +
          `Watchdog đã tự động giải phóng lock an toàn để khôi phục cào bài tự động.`
        ).catch(() => {});
      } else {
        this.logger.warn(`Crawler cron is already running (${Math.round(runningDuration / 1000)}s), skipping this tick`);
        return;
      }
    }
    this.isRunning = true;
    this.lastStartedAt = Date.now();
    this.logger.log('Starting Auto-Crawler Cron...');

    try {
      const sources = await this.prisma.ztteam_crawl_sources.findMany({
        where: { enabled: true },
        include: { target_site: true },
        take: 50, /** Batch limit */
      });

      for (const source of sources) {
        if (!source.target_site) continue;
        
        /** Determine the interval in milliseconds based on frequency_cron */
        let intervalMs = 0;
        switch (source.frequency_cron) {
          case '0 */5 * * * *': intervalMs = 5 * 60 * 1000; break;
          case '0 */15 * * * *': intervalMs = 15 * 60 * 1000; break;
          case '0 */30 * * * *': intervalMs = 30 * 60 * 1000; break;
          case '0 */1 * * *': intervalMs = 1 * 60 * 60 * 1000; break;
          case '0 */2 * * *': intervalMs = 2 * 60 * 60 * 1000; break;
          case '0 */3 * * *': intervalMs = 3 * 60 * 60 * 1000; break;
          case '0 */4 * * *': intervalMs = 4 * 60 * 60 * 1000; break;
          case '0 */6 * * *': intervalMs = 6 * 60 * 60 * 1000; break;
          case '0 */12 * * *': intervalMs = 12 * 60 * 60 * 1000; break;
          case '0 0 * * *': intervalMs = 24 * 60 * 60 * 1000; break;
          default: intervalMs = 60 * 60 * 1000; /** Default 1 hour instead of 2 mins */
        }

        /** Check last crawl time */
        const lastCrawl = await this.prisma.ztteam_crawl_history.findFirst({
          where: { source_id: source.id },
          orderBy: { created_at: 'desc' }
        });

        if (lastCrawl) {
          const timeSinceLastCrawl = Date.now() - new Date(lastCrawl.created_at).getTime();
          if (timeSinceLastCrawl < intervalMs) {
            this.logger.debug(`Skipping source ${source.source_url} (Crawled recently. Next run in ${Math.round((intervalMs - timeSinceLastCrawl) / 60000)} mins)`);
            continue;
          }
        }

        this.logger.log(`Crawling source: ${source.source_url} for site: ${source.target_site.wp_url}`);
        
        try {
          const SOURCE_TIMEOUT_MS = 5 * 60 * 1000; /** 5 phút tối đa cho mỗi nguồn */
          await Promise.race([
            this.ztteam_crawlSource(source),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Timeout 5 phút khi cào nguồn: ${source.source_url}`)), SOURCE_TIMEOUT_MS)
            )
          ]);
        } catch (error: any) {
          this.logger.error(`Failed to crawl source ${source.id}: ${error.message}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`Crawler cron failed: ${error.message}`);
    } finally {
      this.isRunning = false;
      this.logger.log('Auto-Crawler Cron finished.');
    }
  }

  /**
   * ZTTeam: Tạo URL phân trang linh hoạt cho nguồn cào bài viết (hỗ trợ WordPress và CMS thông dụng)
   */
  private ztteam_generatePageUrl(sourceUrl: string, pageNum: number): string {
    if (pageNum <= 1) {
      return sourceUrl;
    }
    try {
      const urlObj = new URL(sourceUrl);
      let pathname = urlObj.pathname;
      if (/\/page\/\d+\/?$/i.test(pathname)) {
        pathname = pathname.replace(/\/page\/\d+\/?$/i, `/page/${pageNum}/`);
      } else {
        pathname = pathname.replace(/\/+$/, '') + `/page/${pageNum}/`;
      }
      urlObj.pathname = pathname;
      return urlObj.toString();
    } catch {
      return sourceUrl;
    }
  }

  /**
   * ZTTeam: Bóc tách danh sách link bài viết chuẩn từ một trang chỉ định (hỗ trợ RSS, Cheerio HTML và Smart Proxy)
   */
  private async ztteam_extractArticleLinksFromPage(pageUrl: string, source: any, pageNum: number): Promise<string[]> {
    const extractedSet = new Set<string>();

    /** Nếu là trang 1 và URL nguồn có thể là RSS feed */
    if (pageNum === 1) {
      try {
        const feed = await this.rssParser.parseURL(pageUrl);
        if (feed.items && feed.items.length > 0) {
          const baseUrl = new URL(pageUrl);
          for (const item of feed.items) {
            if (item.link && this.fetcherService.ztteam_isArticleUrl(item.link, baseUrl.hostname)) {
              extractedSet.add(item.link);
              if (extractedSet.size >= 15) break;
            }
          }
          if (extractedSet.size > 0) {
            return Array.from(extractedSet);
          }
        }
      } catch (e) {
        /** Không phải RSS feed, tiếp tục cào bằng HTML trực tiếp */
      }
    }

    /** Bóc tách HTML trực tiếp */
    try {
      const html = await this.fetcherService.ztteam_fetchHtml(pageUrl);
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);

      /** Loại bỏ các thành phần menu, widget, sidebar, pagination để tránh cào nhầm */
      $('header, footer, nav, aside, .sidebar, .widget, .menu, #menu, .nav-menu, .navigation, .pagination, .breadcrumbs, .breadcrumb, .site-header, .site-footer, .top-bar, .sub-menu, .dropdown-menu').remove();

      const baseUrl = new URL(pageUrl);
      const articleSelectors = [
        'article a',
        'h1 a', 'h2 a', 'h3 a', 'h4 a',
        '.entry-title a', '.post-title a', '.card-title a', '.story-card a', '.article-card a',
        '.post-item a', '.blog-post a', '.story-item a', '.item-title a'
      ];

      $(articleSelectors.join(', ')).each((_: number, el: any) => {
        let href = $(el).attr('href');
        if (!href) return;
        try {
          if (href.startsWith('/')) {
            href = `${baseUrl.origin}${href}`;
          }
          const linkUrl = new URL(href);
          if (this.fetcherService.ztteam_isArticleUrl(linkUrl.href, baseUrl.hostname)) {
            extractedSet.add(linkUrl.href);
          }
        } catch {}
      });

      if (extractedSet.size < 5) {
        $('a').each((_: number, el: any) => {
          let href = $(el).attr('href');
          if (!href) return;
          try {
            if (href.startsWith('/')) {
              href = `${baseUrl.origin}${href}`;
            }
            const linkUrl = new URL(href);
            if (this.fetcherService.ztteam_isArticleUrl(linkUrl.href, baseUrl.hostname)) {
              extractedSet.add(linkUrl.href);
            }
          } catch {}
        });
      }

      if (extractedSet.size === 0) {
        this.logger.log(`No direct HTML article links on ${pageUrl}. Falling back to Smart Proxy extraction...`);
        const proxyLinks = await this.fetcherService.ztteam_extractArticleLinksViaProxy(pageUrl);
        for (const pl of proxyLinks) {
          extractedSet.add(pl);
        }
      }
    } catch (htmlErr: any) {
      this.logger.warn(`Direct HTML scrape failed for ${pageUrl}: ${htmlErr.message}. Attempting Smart Proxy extraction...`);
      try {
        const proxyLinks = await this.fetcherService.ztteam_extractArticleLinksViaProxy(pageUrl);
        for (const pl of proxyLinks) {
          extractedSet.add(pl);
        }
      } catch (proxyErr: any) {
        this.logger.error(`Smart proxy extraction also failed for ${pageUrl}: ${proxyErr.message}`);
      }
    }

    return Array.from(extractedSet).slice(0, 15);
  }

  private async ztteam_crawlSource(source: any) {
    /** 1. Quét phân trang động linh hoạt (Dynamic Flexible Pagination) */
    const urlsToFetch: string[] = [];
    const maxScanPages = 10; /** Quét tối đa 10 trang lưu trữ */

    for (let p = 1; p <= maxScanPages; p++) {
      const pageUrl = this.ztteam_generatePageUrl(source.source_url, p);
      this.logger.log(`[Trang ${p}] Đang quét link bài viết từ nguồn: ${pageUrl}`);

      let pageArticles: string[] = [];
      try {
        const PAGE_TIMEOUT_MS = 60 * 1000; /** 60s max per page link extraction */
        pageArticles = await Promise.race([
          this.ztteam_extractArticleLinksFromPage(pageUrl, source, p),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout 60s khi quét link từ ${pageUrl}`)), PAGE_TIMEOUT_MS)
          )
        ]);
      } catch (pageErr: any) {
        this.logger.warn(`[Trang ${p}] Quét link bài viết thất bại hoặc timeout: ${pageErr.message}`);
        pageArticles = [];
      }

      /** Nếu trang không có bài viết nào (404 hoặc đã hết các trang phân trang), dừng quét */
      if (pageArticles.length === 0) {
        this.logger.log(`[Trang ${p}] Không tìm thấy link bài viết nào (đã hết trang hoặc 404). Kết thúc quét phân trang cho ${source.source_url}.`);
        break;
      }

      /** Kiểm tra lịch sử xem bài nào trên trang này CHƯA được cào */
      const unCrawledOnThisPage: string[] = [];
      for (const url of pageArticles) {
        const history = await this.prisma.ztteam_crawl_history.findUnique({
          where: { source_id_url: { source_id: source.id, url } }
        });

        const isAlreadyProcessed = history && (
          history.status === 'SUCCESS' ||
          history.status.startsWith('SKIPPED') ||
          history.status === 'FAILED'
        );

        if (!isAlreadyProcessed) {
          unCrawledOnThisPage.push(url);
        }
      }

      if (unCrawledOnThisPage.length > 0) {
        this.logger.log(`[Trang ${p}] Phát hiện ${unCrawledOnThisPage.length} bài viết MỚI chưa cào từ ${source.source_url}. Bắt đầu xử lý!`);
        urlsToFetch.push(...unCrawledOnThisPage);
        /** 
         * NGUYÊN TẮC:
         * - Nếu Trang 1 có bài mới: Cào ngay bài mới của Trang 1, dừng quét (break).
         * - Nếu Trang 1 đã cào hết (100% trong history): Vòng lặp tự động sang Trang 2, Trang 3...
         * - Khi tìm thấy trang có bài chưa cào, dừng quét để cào trang đó trước.
         */
        break;
      } else {
        this.logger.log(`[Trang ${p}] Đã cào hết toàn bộ bài viết (${pageArticles.length}/${pageArticles.length} đã có trong lịch sử). Tự động chuyển sang Trang ${p + 1}...`);
      }
    }

    if (urlsToFetch.length === 0) {
      this.logger.warn(`Không tìm thấy bài viết mới nào sau khi quét các trang cho nguồn ${source.source_url}`);
      await this.ztteam_markSourceSyncTime(source.id);
      return;
    }

    /** Mark sync time immediately to lock the crawl interval (e.g. 6 hours) */
    await this.ztteam_markSourceSyncTime(source.id);

    /** 2. Fetch data for un-crawled URLs: Batch size configured in extract_rules_json (default 1) */
    let processedCount = 0;
    let maxArticlesPerCycle = 1;

    try {
      const rules = JSON.parse(source.extract_rules_json || '{}');
      if (rules.batchSize && Number(rules.batchSize) > 0) {
        maxArticlesPerCycle = Math.max(1, Math.min(10, parseInt(rules.batchSize, 10)));
      }
    } catch (e) {}

    let attemptCount = 0;

    for (const url of urlsToFetch) {
      if (attemptCount >= maxArticlesPerCycle) {
        break;
      }

      /** Kiểm tra thời gian thực: Nếu người dùng đã gạt TẮT nguồn này, dừng ngay lập tức */
      const freshSource = await this.prisma.ztteam_crawl_sources.findUnique({
        where: { id: source.id },
        select: { enabled: true }
      });
      if (!freshSource || !freshSource.enabled) {
        this.logger.log(`Source ${source.id} was toggled OFF by user. Stopping crawl loop immediately.`);
        break;
      }

      try {
        /** Check history: Skip already successful, permanently skipped, or previously failed articles */
        const history = await this.prisma.ztteam_crawl_history.findUnique({
          where: { source_id_url: { source_id: source.id, url } }
        });

        if (history && (history.status === 'SUCCESS' || history.status.startsWith('SKIPPED') || history.status === 'FAILED')) {
          continue;
        }

        /** Call full automated pipeline: Crawl clean story -> Source Image -> WordPress + 2K Featured Image -> Queue Fanpage (luân phiên Least-Loaded) */
        let keepContentImages = true;
        try {
          const rules = JSON.parse(source.extract_rules_json || '{}');
          if (rules.keepContentImages !== undefined) {
            keepContentImages = Boolean(rules.keepContentImages);
          }
        } catch (e) {}

        const ARTICLE_TIMEOUT_MS = 3 * 60 * 1000; /** 3 phút tối đa cho một bài viết */
        const result = await Promise.race([
          this.crawlerService.ztteam_crawlAndPublishStory({
            sourceId: source.id,
            sourceUrl: url,
            targetSiteId: source.target_site_id,
            sourceCategory: source.source_category,
            keepContentImages,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout 3 phút khi xử lý bài viết: ${url}`)), ARTICLE_TIMEOUT_MS)
          )
        ]);

        await this.prisma.ztteam_crawl_history.upsert({
          where: { source_id_url: { source_id: source.id, url } },
          create: { source_id: source.id, url, title: result.title, status: 'SUCCESS' },
          update: { title: result.title, status: 'SUCCESS' }
        });

        this.logger.log(`Successfully processed story: "${result.title}" -> WP: ${result.wpPostUrl} | Fanpage Ready: ${result.imageId || 'N/A'}`);
        processedCount++;
        attemptCount++;
      } catch (err: any) {
        /** ZTTeam: Kiểm tra nếu lỗi do vi phạm cổng kiểm duyệt bài viết hoặc bài viết không đủ điều kiện ảnh/nội dung */
        const isConditionUnmet = err.message?.includes('Không phải bài viết hợp lệ') ||
                                 err.message?.includes('Nội dung không đạt tiêu chuẩn bài viết') ||
                                 err.message?.includes('[KHÔNG ĐỦ ĐIỀU KIỆN]');

        if (isConditionUnmet) {
          this.logger.log(`[TỰ ĐỘNG BỎ QUA] URL không đáp ứng điều kiện: ${url} (${err.message})`);
          try {
            await this.prisma.ztteam_crawl_history.upsert({
              where: { source_id_url: { source_id: source.id, url } },
              create: { source_id: source.id, url, status: 'SKIPPED_NOT_ARTICLE' },
              update: { status: 'SKIPPED_NOT_ARTICLE' }
            });
          } catch (e) {}
          continue; /** Chuyển sang URL tiếp theo, không gửi cảnh báo lỗi Telegram */
        }

        attemptCount++; /** Tăng lượt thử để không bao giờ chạy tràn lan khi lỗi */
        this.logger.error(`Failed to process URL ${url}: ${err.message}`);
        
        let sourceDomain = 'Không rõ';
        try {
          sourceDomain = new URL(source.source_url).hostname;
        } catch (e) {
          sourceDomain = source.source_url;
        }

        let targetWpSite = source.target_site?.wp_url || 'Không rõ';
        let memberEmail = 'N/A';
        if (source.target_site?.owner_user_id) {
          const u = await this.prisma.ztteam_users.findUnique({
            where: { id: source.target_site.owner_user_id },
            select: { email: true }
          });
          if (u) memberEmail = u.email;
        }

        /** Xác định bước lỗi cụ thể */
        let failStep = 'Xử lý luồng cào bài viết tự động';
        const extractedError = ztteam_extractErrorMessage(err);
        const em = extractedError.toLowerCase();
        if (em.includes('không thể lấy nội dung') || em.includes('fetch') || em.includes('không phải bài viết')) {
          failStep = 'Bước 1/4: Thu thập và kiểm duyệt nội dung bài viết từ website nguồn';
        } else if (em.includes('ảnh gốc') || em.includes('tải ảnh') || em.includes('image')) {
          failStep = 'Bước 2/4: Tải và xử lý ảnh bài viết';
        } else if (em.includes('wordpress') || em.includes('featured media') || em.includes('tải ảnh lên wp')) {
          failStep = 'Bước 3/4: Đăng bài viết & Featured Media lên Website WordPress đích';
        } else if (em.includes('fanpage') || em.includes('facebook')) {
          failStep = 'Bước 4/4: Chuẩn bị nội dung bài đăng Fanpage Facebook';
        }

        const alertText = this.telegramService.ztteam_formatAlert({
          systemName: `Auto-Crawler (${sourceDomain})`,
          targetSite: targetWpSite,
          sourceUrl: url,
          step: failStep,
          rawError: extractedError,
          nextAction: 'Hệ thống đã tự động BỎ QUA bài viết này để tiếp tục cào các bài tiếp theo, không lặp lại.',
          memberEmail,
        });

        this.telegramService.ztteam_sendMessage(alertText).catch(() => {});
        
        try {
          await this.prisma.ztteam_crawl_history.upsert({
            where: { source_id_url: { source_id: source.id, url } },
            create: { source_id: source.id, url, status: 'SKIPPED_FAILED' },
            update: { status: 'SKIPPED_FAILED' }
          });
        } catch (e) {
          /** Ignore upsert error */
        }

        /** Circuit breaker: Nếu lỗi xác thực WordPress hoặc lỗi hệ thống nghiêm trọng, ngắt ngay vòng lặp */
        const isAuthOrForbidden = err.message?.toLowerCase().includes('forbidden') || 
                                 err.message?.toLowerCase().includes('401') || 
                                 err.message?.toLowerCase().includes('unauthorized') ||
                                 err.message?.toLowerCase().includes('status is forbidden');
        if (isAuthOrForbidden) {
          this.logger.error(`Circuit breaker triggered: WordPress auth error. Aborting remaining URLs to protect API quota.`);
          break;
        }
      }
    }
  }

  /** Update SYNC_CHECK record to mark the last time we checked this source */
  private async ztteam_markSourceSyncTime(sourceId: string): Promise<void> {
    try {
      const syncUrl = 'SYNC_CHECK';
      await this.prisma.ztteam_crawl_history.deleteMany({
        where: { source_id: sourceId, url: syncUrl }
      });
      await this.prisma.ztteam_crawl_history.create({
        data: { source_id: sourceId, url: syncUrl, status: 'SYNC' }
      });
    } catch (e: any) {
      this.logger.warn(`Could not update SYNC_CHECK for source ${sourceId}: ${e.message}`);
    }
  }
}
