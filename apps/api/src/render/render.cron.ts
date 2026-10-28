import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZTTeamRenderProcessor } from './render.processor';
import { ZTTeamWordpressService } from '../wordpress/wordpress.service';
import { ZTTeamHookVideoService } from '../media/hook-video.service';

@Injectable()
export class ZTTeamRenderCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(ZTTeamRenderCron.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderProcessor: ZTTeamRenderProcessor,
    private readonly wordpressService: ZTTeamWordpressService,
    private readonly hookVideoService: ZTTeamHookVideoService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.ENABLE_AUTO_CRON === 'false') {
      this.logger.log('Auto-Render Cron is disabled via ENABLE_AUTO_CRON=false');
      return;
    }
    this.logger.log('Application started, triggering initial render cron...');
    this.ztteam_handleCron();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async ztteam_handleCron() {
    if (process.env.ENABLE_AUTO_CRON === 'false') {
      return;
    }
    if (this.isRunning) {
      this.logger.warn('Render cron is already running, skipping this tick');
      return;
    }
    this.isRunning = true;
    this.logger.log('Starting Auto-Render Cron...');

    try {
      /** ZTTeam: Tự động quét và Render Hook Video 10s cho các bài viết CHƯA ĐĂNG đang ở trạng thái PENDING */
      await this.ztteam_autoRenderPendingVideos();

      /** Find all pages that have auto create enabled and format is reel */
      const pages = await this.prisma.ztteam_pages.findMany({
        where: { auto_create_enabled: true, is_active: true, post_format: { in: ['reel', 'mixed'] } },
        include: { sources: true },
        orderBy: { last_auto_scan_at: 'asc' },
        take: 50,
      });

      for (const page of pages) {
        if (!page.sources || page.sources.length === 0) continue;
        
        try {
          await this.ztteam_processPage(page);
        } catch (error: any) {
          this.logger.error(`Failed to process auto-render for page ${page.id}: ${error.message}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`Render cron failed: ${error.message}`);
    } finally {
      this.isRunning = false;
      this.logger.log('Auto-Render Cron finished.');
    }
  }

  /**
   * ZTTeam: Tự động nhặt các bài viết CHƯA ĐĂNG có video_status = 'PENDING' để Render Video Hook 10s
   * Tối đa 2 video mỗi phút để chạy ngầm êm ái, không làm quá tải CPU/RAM trên VPS
   */
  private async ztteam_autoRenderPendingVideos() {
    try {
      /** ZTTeam: Chỉ tự động render Hook Video cho các Page cấu hình hook_image hoặc text_story. TUYỆT ĐỐI không chạm vào bài của Page Muse! */
      const pendingImages = await this.prisma.ztteam_images.findMany({
        where: {
          video_status: 'PENDING',
          OR: [
            { page_id: null },
            {
              page: {
                video_engine: { in: ['hook_image', 'text_story'] },
              },
            },
          ],
        },
        include: { page: true },
        orderBy: { created_at: 'desc' },
        take: 2,
      });

      if (pendingImages.length === 0) return;

      this.logger.log(`[Auto Hook Video Worker] Tìm thấy ${pendingImages.length} bài viết PENDING, bắt đầu tự động render...`);

      for (const img of pendingImages) {
        try {
          const res = await this.hookVideoService.ztteam_renderHookVideo(img.id, { forceRegenHook: true });
          if (res.success) {
            this.logger.log(`[Auto Hook Video Worker] Render thành công video cho bài ${img.id} (Page: ${img.page?.name || 'Manual Studio'}): ${res.videoUrl}`);
          } else {
            this.logger.warn(`[Auto Hook Video Worker] Render bài ${img.id} trả về lỗi: ${res.error}`);
          }
        } catch (err: any) {
          this.logger.error(`[Auto Hook Video Worker] Lỗi render bài ${img.id}: ${err.message}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`[Auto Hook Video Worker] Lỗi truy vấn pending videos: ${e.message}`);
    }
  }

  private async ztteam_processPage(page: any) {
    this.logger.log(`Checking new posts for page: ${page.name}`);
    
    let processedCount = 0;
    const batchSize = page.auto_scan_batch_size || 3;
    const maxAgeDays = page.auto_max_post_age_days || 7;
    const now = new Date();

    const lastScanTime = page.last_auto_scan_at ? new Date(page.last_auto_scan_at) : null;
    const intervalHours = page.auto_scan_interval_hours || 2;
    
    if (lastScanTime) {
      const hoursSinceLastScan = (now.getTime() - lastScanTime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastScan < intervalHours) {
        this.logger.debug(`Skipping page ${page.name}, interval not reached (${hoursSinceLastScan.toFixed(2)} / ${intervalHours} hours)`);
        return;
      }
    }

    let scannedAnySource = false;

    for (const source of page.sources) {
      if (processedCount >= batchSize) break;

      try {
        /** Get latest posts from the target site */
        /** Using owner_user_id from page to authenticate with WP */
        const posts = await this.wordpressService.ztteam_getPosts(source.target_site_id, page.owner_user_id, source.target_category_id, source.target_tags);
        
        /** Process oldest first (FIFO) so chronological order is maintained on Fanpage */
        const reversedPosts = [...posts].reverse();

        for (const post of reversedPosts) {
          if (processedCount >= batchSize) break;

          /** Check age */
          const postDate = new Date(post.date);
          const diffTime = Math.abs(now.getTime() - postDate.getTime());
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          if (diffDays > maxAgeDays) {
            continue; /** Too old */
          }

          /** Check if already processed globally across any page in reels, reel_history, images, image_history by ID, Title or URL */
          const postWpIdStr = post.id.toString();
          const postTitleTrimmed = (post.title || '').trim();

          const alreadyInReelsGlobally = await this.prisma.ztteam_reels.findFirst({
            where: {
              OR: [
                { wp_post_id: postWpIdStr },
                ...(postTitleTrimmed ? [{ wp_post_title: postTitleTrimmed }] : []),
                ...(post.link ? [{ wp_post_url: post.link }] : [])
              ]
            },
            select: { id: true, page_id: true }
          });
          if (alreadyInReelsGlobally) continue;

          const alreadyInReelHistoryGlobally = await this.prisma.ztteam_reel_history.findFirst({
            where: { wp_post_id: postWpIdStr },
            select: { id: true, page_id: true }
          });
          if (alreadyInReelHistoryGlobally) continue;

          const alreadyInImagesGlobally = await this.prisma.ztteam_images.findFirst({
            where: {
              OR: [
                { wp_post_id: postWpIdStr },
                ...(postTitleTrimmed ? [{ wp_post_title: postTitleTrimmed }] : []),
                ...(post.link ? [{ wp_post_url: post.link }] : [])
              ]
            },
            select: { id: true, page_id: true }
          });
          if (alreadyInImagesGlobally) continue;

          const alreadyInImageHistoryGlobally = await this.prisma.ztteam_image_history.findFirst({
            where: { wp_post_id: postWpIdStr },
            select: { id: true, page_id: true }
          });
          if (alreadyInImageHistoryGlobally) continue;

          /** Check queue limit */
          const queueCount = await this.prisma.ztteam_reels.count({
            where: {
              page_id: page.id,
              status: { in: ['QUEUED', 'RENDERING'] }
            }
          });
          if (queueCount >= (page.auto_queue_limit || 10)) {
            this.logger.log(`Queue limit reached for page ${page.name}`);
            break;
          }

          /** Create new Reel record */
          const reel = await this.prisma.ztteam_reels.create({
            data: {
              page_id: page.id,
              wp_post_id: post.id.toString(),
              wp_post_title: post.title,
              wp_post_url: post.link,
              template_id: page.default_reel_template_id || 'default',
              status: 'QUEUED',
            },
          });

          /** Mark post as used IMMEDIATELY to prevent re-queuing on failure */
          await this.prisma.ztteam_reel_history.upsert({
            where: { page_id_wp_post_id: { page_id: page.id, wp_post_id: post.id.toString() } },
            create: { page_id: page.id, wp_post_id: post.id.toString() },
            update: {},
          });

          /** Add to BullMQ */
          await this.renderProcessor.ztteam_addJob({
            reelId: reel.id,
            pageId: page.id,
            wpPostId: post.id.toString(),
            wpPostTitle: post.title,
            templateId: page.default_reel_template_id || 'default',
          });

          this.logger.log(`Auto-queued reel ${reel.id} for post ${post.title}`);
          processedCount++;
        }
        scannedAnySource = true;
      } catch (err: any) {
        this.logger.error(`Error processing source for page ${page.name}: ${err.message}`);
      }
    }

    if (scannedAnySource) {
      await this.prisma.ztteam_pages.update({
        where: { id: page.id },
        data: { last_auto_scan_at: new Date() },
      });
      this.logger.log(`Updated last_auto_scan_at for page ${page.name}`);
    }
  }
}
