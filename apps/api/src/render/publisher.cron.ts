import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ZTTeamFacebookService } from '../facebook/facebook.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import { ztteam_getReelsPath, ztteam_getImagesPath, ztteam_getStorageRoot } from '../common/ztteam_storage.util';
import { TelegramService, ztteam_extractErrorMessage } from '../telegram/telegram.service';
import { ztteam_getNewsComment } from '../common/ztteam_news_comment.util';

/**
 * ZTTeam: Kho Mồi Kích Hoạt Đa Dạng (Dynamic Viral Hook Comments)
 * Luân phiên và ngẫu nhiên các mẫu câu kích thích tò mò và kêu gọi để lại comment
 * Giúp tối ưu tương tác tự nhiên và tuyệt đối chống Facebook quét trùng lặp spam.
 */
export function ztteam_getRandomHookComment(seed?: string): string {
  const HOOK_TEMPLATES = [
    `...I know you're all very curious about what happens next, so if you want to read on, leave "YES" in the comments below! 👇`,
    `...Want to know the full truth of what happened next? Drop a "YES" or "NEXT" below! 👇🔥`,
    `...The next part will leave you completely speechless! Leave "YES" in the comments if you want me to share it right away! 👇✨`,
    `...Curious about the unexpected twist? Comment "YES" down below to continue reading! 👇👀`,
    `...If you're eager to see how this story ends, let me know by leaving a "YES" in the comments! 👇❤️`,
    `...Things took a crazy turn right after this! Drop "YES" below and I'll post the continuation! 👇💬`,
    `...Can you guess what happened next? Leave "YES" in the comments if you want the next part! 👇👇`,
    `...The ending completely shocked everyone! Comment "YES" or "MORE" below if you want the full story! 👇⚡`,
    `...Are you ready for the shocking revelation? Leave "YES" down below to find out! 👇😲`,
    `...You won't believe what they discovered next! Comment "YES" below and I'll send you the rest! 👇🙏`,
    `...Want to know how this ends? Drop a quick "YES" below and I'll unlock Part 2 for you! 👇💫`,
    `...I was blown away when I read the ending! Leave "YES" below if you want the conclusion! 👇📖`
  ];

  if (seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash) % HOOK_TEMPLATES.length;
    return HOOK_TEMPLATES[index];
  }

  const randomIndex = Math.floor(Math.random() * HOOK_TEMPLATES.length);
  return HOOK_TEMPLATES[randomIndex];
}

@Injectable()
export class ZTTeamPublisherCron {
  private readonly logger = new Logger(ZTTeamPublisherCron.name);
  private isRunning = false;
  /** ZTTeam: Lưu vết thời điểm xuất bản gần nhất trên toàn hệ thống (mọi Page) để chống Burst API */
  private ztteam_lastGlobalPublishTimestamp = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookService: ZTTeamFacebookService,
    private readonly eventEmitter: EventEmitter2,
    private readonly telegramService: TelegramService,
  ) { }

  @Cron(CronExpression.EVERY_MINUTE)
  async ztteam_handleCron() {
    if (process.env.ENABLE_AUTO_CRON === 'false') {
      return;
    }

    if (this.isRunning) {
      this.logger.warn('Publisher cron is already running, skipping this tick');
      return;
    }
    this.isRunning = true;

    try {
      /** 0. Quy trinh delayed comment 2 buoc da duoc bo, thay the bang instant comment ngay khi dang bai */
      // await this.ztteam_handleDelayedComments();

      /** 1. Tìm các Reel đã render xong đang chờ đăng (xếp theo thời gian tạo cũ nhất trước) */
      const pendingReels = await this.prisma.ztteam_reels.findMany({
        where: {
          status: 'COMPLETED',
          is_posted: false,
          source_type: { not: 'TIKTOK_CLONE' }
        },
        include: { page: { include: { fb_account: true } } },
        orderBy: { created_at: 'asc' },
      });

      /** 2. Tìm các Ảnh đã tạo xong đang chờ đăng (xếp theo thời gian tạo cũ nhất trước) */
      const pendingImages = await this.prisma.ztteam_images.findMany({
        where: {
          status: 'COMPLETED',
          is_posted: false,
        },
        include: { page: { include: { fb_account: true } } },
        orderBy: { created_at: 'asc' },
      });

      if (pendingReels.length === 0 && pendingImages.length === 0) {
        return;
      }

      /** 3. Tập hợp danh sách các Page có bài chờ đăng */
      const pagesMap = new Map<string, any>();
      for (const reel of pendingReels) {
        if (reel.page && !pagesMap.has(reel.page_id)) {
          pagesMap.set(reel.page_id, reel.page);
        }
      }
      for (const img of pendingImages) {
        if (img.page && img.page_id && !pagesMap.has(img.page_id)) {
          pagesMap.set(img.page_id, img.page);
        }
      }

      const now = new Date();

      /** 4. Duyệt các Page để lọc ra danh sách bài viết ứng viên đủ điều kiện xuất bản */
      const eligibleCandidates: Array<{
        page: any;
        selectedItem: { type: 'reel_legacy' | 'image_reel' | 'image_only'; data: any };
        diffMinutesFromLastPost: number;
        itemCreatedAt: number;
      }> = [];

      for (const [pageId, page] of pagesMap.entries()) {
        const { auto_publish_enabled, schedule_mode, schedule_fixed_times, schedule_immediate_gap_minutes, post_format } = page;

        /** Nếu Page đang tắt tự động đăng bài hoặc bị vô hiệu hóa thì bỏ qua */
        if (auto_publish_enabled === false || page.is_active === false) {
          continue;
        }

        /**
         * ZTTeam: Lấy bài đăng thành công gần nhất của Page này dựa trên posted_at
         * TUYỆT ĐỐI KHÔNG dùng updated_at vì LinkTracker hay Analytics chạy định kỳ sẽ làm sai lệch thời gian xuất bản thực tế.
         */
        const [lastPublishedReel, lastPublishedImage] = await Promise.all([
          this.prisma.ztteam_reels.findFirst({
            where: { page_id: pageId, is_posted: true, posted_at: { not: null } },
            orderBy: { posted_at: 'desc' },
            select: { posted_at: true },
          }),
          this.prisma.ztteam_images.findFirst({
            where: { page_id: pageId, is_posted: true, posted_at: { not: null } },
            orderBy: { posted_at: 'desc' },
            select: { posted_at: true },
          }),
        ]);

        let lastPostTime: Date | null = null;
        let lastPostType: 'reel' | 'image' | null = null;

        if (lastPublishedReel?.posted_at) {
          lastPostTime = new Date(lastPublishedReel.posted_at);
          lastPostType = 'reel';
        }
        if (lastPublishedImage?.posted_at) {
          const imgDate = new Date(lastPublishedImage.posted_at);
          if (!lastPostTime || imgDate > lastPostTime) {
            lastPostTime = imgDate;
            lastPostType = 'image';
          }
        }

        /** Chống spam gọi API nếu vừa gặp lỗi đăng bài trong vòng 5 phút gần nhất */
        const [lastFailedReel, lastFailedImage] = await Promise.all([
          this.prisma.ztteam_reels.findFirst({
            where: { page_id: pageId, status: 'FAILED' },
            orderBy: { updated_at: 'desc' },
            select: { updated_at: true },
          }),
          this.prisma.ztteam_images.findFirst({
            where: { page_id: pageId, status: 'FAILED' },
            orderBy: { updated_at: 'desc' },
            select: { updated_at: true },
          }),
        ]);
        let lastFailedTime: Date | null = null;
        if (lastFailedReel) lastFailedTime = new Date(lastFailedReel.updated_at);
        if (lastFailedImage) {
          const fTime = new Date(lastFailedImage.updated_at);
          if (!lastFailedTime || fTime > lastFailedTime) lastFailedTime = fTime;
        }

        if (lastFailedTime) {
          const diffMinutesFromFailure = Math.floor((now.getTime() - lastFailedTime.getTime()) / 60000);
          if (diffMinutesFromFailure < 5) {
            this.logger.warn(`Page ${page.name}: Vừa gặp lỗi đăng bài cách đây ${diffMinutesFromFailure}m. Tạm dừng 5m để bảo vệ Fanpage.`);
            continue;
          }
        }

        const diffMinutesFromLastPost = lastPostTime
          ? Math.floor((now.getTime() - lastPostTime.getTime()) / 60000)
          : Infinity;

        // Giãn cách tối thiểu giữa 2 bài đăng bất kỳ trên cùng 1 Page là 10 phút để tránh đăng dồn dập
        if (diffMinutesFromLastPost < 10) {
          this.logger.log(`Page ${page.name}: Vừa đăng bài cách đây ${diffMinutesFromLastPost}m (< 10m). Chờ giãn cách an toàn.`);
          continue;
        }

        let shouldPublish = false;

        if (schedule_mode === 'fixed') {
          if (schedule_fixed_times && Array.isArray(schedule_fixed_times) && schedule_fixed_times.length > 0) {
            /** Chuẩn hóa ngày & giờ theo múi giờ Việt Nam (Asia/Ho_Chi_Minh - UTC+7) */
            const vnDateFormatter = new Intl.DateTimeFormat('en-CA', {
              timeZone: 'Asia/Ho_Chi_Minh',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            });
            const todayVnDate = vnDateFormatter.format(now);

            const vnTimeFormatter = new Intl.DateTimeFormat('en-US', {
              timeZone: 'Asia/Ho_Chi_Minh',
              hour: 'numeric',
              minute: 'numeric',
              hour12: false,
            });
            const nowParts = vnTimeFormatter.formatToParts(now);
            const vnH = parseInt(nowParts.find(p => p.type === 'hour')?.value || '0', 10);
            const vnM = parseInt(nowParts.find(p => p.type === 'minute')?.value || '0', 10);
            const currentMinutes = vnH * 60 + vnM;

            // Xác định thời điểm bài đăng gần nhất theo ngày & phút tại VN
            let isLastPostToday = false;
            let lastPostVnMinutes = -1;
            if (lastPostTime) {
              const lastPostVnDate = vnDateFormatter.format(lastPostTime);
              if (lastPostVnDate === todayVnDate) {
                isLastPostToday = true;
                const lpParts = vnTimeFormatter.formatToParts(lastPostTime);
                const lpH = parseInt(lpParts.find(p => p.type === 'hour')?.value || '0', 10);
                const lpM = parseInt(lpParts.find(p => p.type === 'minute')?.value || '0', 10);
                lastPostVnMinutes = lpH * 60 + lpM;
              }
            }

            for (const time of schedule_fixed_times as string[]) {
              const [h, m] = time.split(':').map(Number);
              const fixedTimeMinutes = h * 60 + m;

              /**
               * Cửa sổ xuất bản: từ giờ hẹn (fixedTimeMinutes) đến 60 phút sau.
               * Giúp xử lý mượt mà khi hệ thống có hàng đợi nhiều page phải đăng tuần tự.
               */
              if (currentMinutes >= fixedTimeMinutes && currentMinutes < fixedTimeMinutes + 60) {
                /**
                 * Khung giờ này ĐÃ ĐƯỢC XUẤT BẢN hôm nay nếu có bài đăng sau thời điểm (fixedTimeMinutes - 5)
                 */
                const slotAlreadyServed = isLastPostToday && lastPostVnMinutes >= (fixedTimeMinutes - 5);
                if (slotAlreadyServed) {
                  this.logger.log(`Page ${page.name}: Khung giờ ${time} hôm nay đã xuất bản lúc ${Math.floor(lastPostVnMinutes / 60).toString().padStart(2, '0')}:${(lastPostVnMinutes % 60).toString().padStart(2, '0')}. Bỏ qua.`);
                  break;
                }
                shouldPublish = true;
                break;
              }
            }
          }
        } else {
          /** immediate / gap mode */
          const gapMinutes = schedule_immediate_gap_minutes || 60;
          if (!lastPostTime || diffMinutesFromLastPost >= gapMinutes) {
            shouldPublish = true;
          } else {
            this.logger.log(`Page ${page.name}: Đang chờ đủ khoảng cách gap (${diffMinutesFromLastPost}/${gapMinutes}m).`);
          }
        }

        if (!shouldPublish) {
          continue;
        }

        /** 5. Phân loại bài đăng Video Reel và Ảnh cho Page này */
        const pageReelsOld = pendingReels.filter(r => r.page_id === pageId);
        const pageImagesWithVideo = pendingImages.filter(i => i.page_id === pageId && i.video_url);
        const pageImagesOnly = pendingImages.filter(i => i.page_id === pageId && !i.video_url);

        /** Tập hợp tất cả các ứng viên Reel */
        const allAvailableReels = [
          ...pageReelsOld.map(r => ({ type: 'reel_legacy' as const, data: r })),
          ...pageImagesWithVideo.map(i => ({ type: 'image_reel' as const, data: i })),
        ];

        /** Tập hợp tất cả các ứng viên Ảnh */
        const allAvailableImages = pageImagesOnly.map(i => ({ type: 'image_only' as const, data: i }));

        let selectedItem: { type: 'reel_legacy' | 'image_reel' | 'image_only'; data: any } | null = null;

        if (post_format === 'reel') {
          /** Cấu hình: Nếu chọn reel thì đăng reel, nếu bài chuẩn bị đăng ko có reel thì đăng ảnh (đảm bảo phải có bài để đăng) */
          if (allAvailableReels.length > 0) {
            selectedItem = allAvailableReels[0];
          } else if (allAvailableImages.length > 0) {
            selectedItem = allAvailableImages[0];
          } else if (pageImagesWithVideo.length > 0) {
            selectedItem = { type: 'image_only', data: pageImagesWithVideo[0] };
          }
        } else if (post_format === 'image') {
          /** Cấu hình: Nếu chọn ảnh thì chắc chắn phải đăng ảnh */
          if (allAvailableImages.length > 0) {
            selectedItem = allAvailableImages[0];
          } else if (pageImagesWithVideo.length > 0) {
            selectedItem = { type: 'image_only', data: pageImagesWithVideo[0] };
          }
        } else {
          /** Cấu hình: Nếu chọn ảnh và reel xen kẽ thì đăng đúng chuẩn, trường hợp reel ko có vẫn đăng ảnh */
          if (lastPostType === 'reel') {
            /** Lượt trước đăng Reel -> Lượt này đăng Ảnh */
            if (allAvailableImages.length > 0) {
              selectedItem = allAvailableImages[0];
            } else if (pageImagesWithVideo.length > 0) {
              selectedItem = { type: 'image_only', data: pageImagesWithVideo[0] };
            }
          } else {
            /** Lượt trước đăng Ảnh -> Lượt này đăng Reel. Trường hợp reel ko có vẫn đăng ảnh */
            if (allAvailableReels.length > 0) {
              selectedItem = allAvailableReels[0];
            } else if (allAvailableImages.length > 0) {
              selectedItem = allAvailableImages[0];
            } else if (pageImagesWithVideo.length > 0) {
              selectedItem = { type: 'image_only', data: pageImagesWithVideo[0] };
            }
          }
        }

        if (selectedItem) {
          const itemDate = selectedItem.data.created_at || selectedItem.data.updated_at || now;
          eligibleCandidates.push({
            page,
            selectedItem,
            diffMinutesFromLastPost,
            itemCreatedAt: new Date(itemDate).getTime(),
          });
        } else {
          this.logger.log(`Page ${page.name}: Không có bài viết đáp ứng điều kiện theo cấu hình "${post_format}" -> Bỏ qua, không gọi API đăng Facebook.`);
        }
      }

      if (eligibleCandidates.length === 0) {
        return;
      }

      /**
       * ZTTeam: Thuật toán điều phối hàng đợi (Priority Dispatcher):
       * 1. Ưu tiên Page nào lâu nhất chưa có bài đăng (diffMinutesFromLastPost giảm dần)
       * 2. Nếu bằng nhau, ưu tiên bài viết được tạo sớm nhất (itemCreatedAt tăng dần)
       */
      eligibleCandidates.sort((a, b) => {
        const diffA = a.diffMinutesFromLastPost === Infinity ? 999999 : a.diffMinutesFromLastPost;
        const diffB = b.diffMinutesFromLastPost === Infinity ? 999999 : b.diffMinutesFromLastPost;
        if (diffB !== diffA) {
          return diffB - diffA;
        }
        return a.itemCreatedAt - b.itemCreatedAt;
      });

      this.logger.log(`[ZTTeam Global Dispatcher] Có ${eligibleCandidates.length} bài sẵn sàng xuất bản. Đang điều phối bài ưu tiên cao nhất...`);

      /**
       * ZTTeam: Kiểm tra và đảm bảo khoảng cách an toàn toàn cục (Global Rate Limiter):
       * Tuyệt đối không gọi Facebook API nếu lần đăng gần nhất trên toàn hệ thống chưa đủ 45 giây.
       */
      const elapsedSinceLastGlobal = Date.now() - this.ztteam_lastGlobalPublishTimestamp;
      const MIN_GLOBAL_GAP_MS = 45000;
      if (this.ztteam_lastGlobalPublishTimestamp > 0 && elapsedSinceLastGlobal < MIN_GLOBAL_GAP_MS) {
        const waitMs = MIN_GLOBAL_GAP_MS - elapsedSinceLastGlobal;
        this.logger.log(`[ZTTeam Global Dispatcher] Giãn cách bảo vệ Meta: Chờ thêm ${Math.round(waitMs / 1000)}s trước khi gọi Facebook API...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      /** Lấy bài viết ưu tiên số 1 để đăng trong chu kỳ này */
      const target = eligibleCandidates[0];
      const { selectedItem, page } = target;

      this.logger.log(`[ZTTeam Global Dispatcher] Đang xuất bản cho Page: ${page.name} (Đã chờ: ${target.diffMinutesFromLastPost === Infinity ? 'Mới/Vô cực' : target.diffMinutesFromLastPost + 'm'})`);

      if (selectedItem.type === 'reel_legacy') {
        await this.ztteam_publishReel(selectedItem.data, page);
      } else if (selectedItem.type === 'image_only') {
        await this.ztteam_publishImage(selectedItem.data, page, true);
      } else {
        await this.ztteam_publishImage(selectedItem.data, page, false);
      }

      this.ztteam_lastGlobalPublishTimestamp = Date.now();
    } catch (error: any) {
      this.logger.error(`Unified publisher cron error: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Đăng video Reel lên Facebook Page
   */
  private async ztteam_publishReel(reel: any, page: any) {
    this.logger.log(`Auto-publishing reel ${reel.id} to page ${page.name}...`);

    try {
      /** ZTTeam: Kiểm tra an toàn trước khi gọi Facebook API - Không bao giờ đăng nếu bài này đã được xuất bản ở Page khác */
      const reelTitleTrimmed = (reel.wp_post_title || '').trim();
      const alreadyPostedReel = await this.prisma.ztteam_reels.findFirst({
        where: {
          id: { not: reel.id },
          is_posted: true,
          OR: [
            { wp_post_id: reel.wp_post_id },
            ...(reelTitleTrimmed ? [{ wp_post_title: reelTitleTrimmed }] : [])
          ]
        },
        include: { page: true }
      });

      const alreadyPostedImage = await this.prisma.ztteam_images.findFirst({
        where: {
          is_posted: true,
          OR: [
            { wp_post_id: reel.wp_post_id },
            ...(reelTitleTrimmed ? [{ wp_post_title: reelTitleTrimmed }] : [])
          ]
        },
        include: { page: true }
      });

      if (alreadyPostedReel || alreadyPostedImage) {
        const otherPageName = alreadyPostedReel?.page?.name || alreadyPostedImage?.page?.name || 'trang khác';
        this.logger.warn(`[CHỐNG TRÙNG TOÀN CỤC] Reel "${reel.wp_post_title}" (ID #${reel.wp_post_id}) ĐÃ ĐƯỢC XUẤT BẢN trên Fanpage "${otherPageName}". Tự động HỦY bản sao trên Page "${page.name}" để không trùng.`);
        await this.prisma.ztteam_reels.delete({ where: { id: reel.id } }).catch(() => {});
        return;
      }
      const videoPath = ztteam_getReelsPath(reel.id, 'output.mp4');

      if (!fs.existsSync(videoPath)) {
        throw new Error('File video không tồn tại trên server');
      }

      let description = reel.ai_caption || reel.wp_post_title || '';

      /** Xóa tracking link cũ nếu có */
      if (description.includes('utm_source=reel')) {
        const parts = description.split(/(👉|🔥|📌|👇|🔗|Read more:)/);
        if (parts.length > 1) {
          description = parts[0].trim();
        } else {
          description = description.split(/\n\n.*utm_source=reel/)[0].trim();
        }
      }

      const slugify = (text: string) => {
        if (!text) return '';
        return text.toString().toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-').trim();
      };

      const utmMedium = slugify(page?.fb_account?.name || 'account');
      const utmCampaign = slugify(page?.name || 'page');
      const trackingLink = reel.wp_post_url ? `${reel.wp_post_url}${reel.wp_post_url.includes('?') ? '&' : '?'}utm_source=reel&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}` : '';

      const shouldAttachLinkNow = (page as any).link_mode !== 'view_threshold' && (page as any).link_mode !== 'disabled';

      if (shouldAttachLinkNow && page.add_link_to_caption && reel.wp_post_url) {
        const prefixes = [
          '👉 Discover more here:',
          '🔥 Read the full story:',
          '📌 Check out the details:',
          '👇 Full article link:',
          '🔗 Learn more at:'
        ];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        description = `${prefix} ${trackingLink}\n\n${description}`;
      }

      const response = await this.facebookService.ztteam_publishReel(
        page.fb_page_id,
        videoPath,
        description
      );

      let linkInjected = false;
      /** ZTTeam: Ngay khi dang video Reel thanh cong, gan link vao comment luon neu link_mode khong phai view_threshold */
      if (shouldAttachLinkNow && response.id && (reel.wp_post_url || trackingLink)) {
        try {
          const commentText = ztteam_getNewsComment(trackingLink || reel.wp_post_url);
          if (commentText) {
            await this.facebookService.ztteam_publishComment(
              page.fb_page_id,
              response.id,
              commentText
            );
            linkInjected = true;
          }
        } catch (e: any) {
          this.logger.error(`Failed to post comment for reel ${reel.id}: ${e.message}`);
        }
      }

      await this.prisma.ztteam_reels.update({
        where: { id: reel.id },
        data: {
          status: 'POSTED',
          is_posted: true,
          posted_at: new Date(),
          fb_post_id: response.id,
          post_retry_count: 0,
          link_injected: linkInjected,
          link_injected_at: linkInjected ? new Date() : null,
          link_injected_type: linkInjected ? 'comment' : null,
        }
      });

      await this.prisma.ztteam_reel_history.upsert({
        where: {
          page_id_wp_post_id: {
            page_id: page.id,
            wp_post_id: reel.wp_post_id,
          }
        },
        create: {
          page_id: page.id,
          wp_post_id: reel.wp_post_id,
          title: reel.wp_post_title,
        },
        update: {},
      }).catch(() => {});

      this.eventEmitter.emit('reel.updated', { id: reel.id, status: 'POSTED', fb_post_id: response.id });
      this.logger.log(`Reel ${reel.id} successfully auto-published to page ${page.name}`);
    } catch (error: any) {
      const extractedError = ztteam_extractErrorMessage(error);
      const isIdentityCheckpoint =
        extractedError.includes('4854002') ||
        extractedError.includes('xác nhận danh tính') ||
        extractedError.includes('confirm your identity');

      let currentRetries = (reel.post_retry_count || 0) + 1;
      this.logger.error(`Failed to auto-publish reel ${reel.id} (Attempt ${currentRetries}/3): ${extractedError}`);

      if (isIdentityCheckpoint) {
        /**
         * ZTTeam: Kích hoạt Circuit Breaker ngay lập tức!
         * Meta yêu cầu xác nhận danh tính trên điện thoại.
         * Dừng thử lại ngay (set 3) và tạm dừng auto_publish trên Page để bảo vệ BM và các Page khác.
         */
        currentRetries = 3;
        await this.prisma.ztteam_pages.update({
          where: { id: page.id },
          data: {
            auto_publish_enabled: false,
            token_status: 'checkpoint_required'
          }
        }).catch(() => {});
        this.logger.warn(`[CIRCUIT BREAKER] Page ${page.name} kích hoạt bảo vệ do Facebook yêu cầu xác nhận danh tính. Tạm ngưng auto-publish.`);
      }

      if (currentRetries < 3) {
        await this.prisma.ztteam_reels.update({
          where: { id: reel.id },
          data: {
            post_retry_count: currentRetries,
            error_log: `Lần thử ${currentRetries}/3 thất bại: ${extractedError}`,
          }
        });
        this.logger.log(`Reel ${reel.id} kept in COMPLETED status for next time slot retry (Attempt ${currentRetries}/3)`);
      } else {
        await this.prisma.ztteam_reels.update({
          where: { id: reel.id },
          data: {
            status: 'FAILED',
            post_retry_count: currentRetries,
            error_log: isIdentityCheckpoint
              ? `[CIRCUIT BREAKER] Facebook yêu cầu Quản trị viên mở điện thoại xác minh danh tính (Subcode 4854002): ${extractedError}`
              : `Lỗi đăng bài sau 3 lần thử: ${extractedError}`,
          }
        });

        let ownerEmail = 'N/A';
        if (page?.fb_account?.owner_user_id) {
          const u = await this.prisma.ztteam_users.findUnique({ where: { id: page.fb_account.owner_user_id }, select: { email: true } });
          if (u) ownerEmail = u.email;
        }

        const alertMsg = this.telegramService.ztteam_formatAlert({
          systemName: isIdentityCheckpoint ? 'Xác Minh Danh Tính Fanpage' : 'Xuất Bản Fanpage (Đăng Video Reel)',
          fanpageName: page.name || 'Không rõ',
          postTitle: reel.wp_post_title || 'Video Reel',
          step: 'Đăng tải video Reel lên Facebook qua Graph API',
          rawError: extractedError,
          nextAction: isIdentityCheckpoint
            ? 'Hệ thống đã tự động tạm ngắt xuất bản trên Page này để bảo vệ BM. Vui lòng mở ứng dụng Facebook trên điện thoại -> Chuyển sang Page -> Đăng thử 1 bài viết để xác nhận danh tính, sau đó bật lại tự động đăng trên web.'
            : 'Đã thử lại 3 lần thất bại. Vui lòng kiểm tra lại token Fanpage hoặc quyền đăng bài.',
          memberEmail: ownerEmail,
        });
        this.telegramService.ztteam_sendMessage(alertMsg).catch(() => {});
      }
    }
  }

  /**
   * Đăng bài ảnh lên Facebook Page
   */
  private async ztteam_publishImage(image: any, page: any, forceImageOnly = false) {
    this.logger.log(`Auto-publishing image ${image.id} to page ${page.name} (forceImageOnly: ${forceImageOnly})...`);

    try {
      /** ZTTeam: Kiểm tra an toàn trước khi gọi Facebook API - Không bao giờ đăng nếu bài này đã được xuất bản ở Page khác */
      const imageTitleTrimmed = (image.wp_post_title || '').trim();
      const alreadyPostedImage = await this.prisma.ztteam_images.findFirst({
        where: {
          id: { not: image.id },
          is_posted: true,
          OR: [
            { wp_post_id: image.wp_post_id },
            ...(imageTitleTrimmed ? [{ wp_post_title: imageTitleTrimmed }] : [])
          ]
        },
        include: { page: true }
      });

      const alreadyPostedReel = await this.prisma.ztteam_reels.findFirst({
        where: {
          is_posted: true,
          OR: [
            { wp_post_id: image.wp_post_id },
            ...(imageTitleTrimmed ? [{ wp_post_title: imageTitleTrimmed }] : [])
          ]
        },
        include: { page: true }
      });

      if (alreadyPostedImage || alreadyPostedReel) {
        const otherPageName = alreadyPostedImage?.page?.name || alreadyPostedReel?.page?.name || 'trang khác';
        this.logger.warn(`[CHỐNG TRÙNG TOÀN CỤC] Bài viết "${image.wp_post_title}" (ID #${image.wp_post_id}) ĐÃ ĐƯỢC XUẤT BẢN trên Fanpage "${otherPageName}". Tự động HỦY bản sao trên Page "${page.name}" để không trùng.`);
        await this.prisma.ztteam_images.delete({ where: { id: image.id } }).catch(() => {});
        return;
      }
      let absoluteImagePath = ztteam_getImagesPath(image.id, 'output.png');

      /** Fallback to image.image_url if output.png is not in standard dir */
      if (!fs.existsSync(absoluteImagePath) && image.image_url) {
        let fallback: string;
        if (image.image_url.startsWith('/storage') || image.image_url.startsWith('storage')) {
          fallback = path.join(ztteam_getStorageRoot(), image.image_url.replace(/^\/?storage[/\\]?/, ''));
        } else if (fs.existsSync(image.image_url)) {
          fallback = image.image_url;
        } else {
          fallback = path.join(ztteam_getStorageRoot(), image.image_url.replace(/^[/\\]+/, ''));
        }
        if (fs.existsSync(fallback)) {
          absoluteImagePath = fallback;
        }
      }

      if (!fs.existsSync(absoluteImagePath)) {
        this.logger.warn(`File ảnh không tồn tại trên server: ${absoluteImagePath}`);
        await this.prisma.ztteam_images.update({
          where: { id: image.id },
          data: {
            status: 'FAILED',
            error_log: 'File ảnh không tồn tại trên máy chủ (được tạo từ môi trường khác hoặc đã bị xóa)',
          }
        });
        return;
      }

      let caption = image.ai_caption || image.wp_post_title || '';

      const slugify = (text: string) => {
        if (!text) return '';
        return text.toString().toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-').trim();
      };

      const utmMedium = slugify(page?.fb_account?.name || 'account');
      const utmCampaign = slugify(page?.name || 'page');
      const trackingLink = image.wp_post_url ? `${image.wp_post_url}${image.wp_post_url.includes('?') ? '&' : '?'}utm_source=image&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}` : '';

      const shouldAttachLinkNow = (page as any).link_mode !== 'view_threshold' && (page as any).link_mode !== 'disabled';

      if (shouldAttachLinkNow && page.add_link_to_caption && image.wp_post_url) {
        const prefixes = [
          '👉 Discover more here:',
          '🔥 Read the full story:',
          '📌 Check out the details:',
          '👇 Full article link:',
          '🔗 Learn more at:'
        ];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        caption = `${prefix} ${trackingLink}\n\n${caption}`;
      }

      let fbPostId: string;
      /** ZTTeam: Nếu bài viết đã tạo Video Reel và không bắt buộc chỉ đăng ảnh, ưu tiên xuất bản Reel/Video lên Facebook */
      if (image.video_url && !forceImageOnly) {
        let absoluteVideoPath = '';
        if (image.video_url.startsWith('/storage/')) {
          absoluteVideoPath = path.join(ztteam_getStorageRoot(), image.video_url.replace(/^\/storage\//, ''));
        } else {
          absoluteVideoPath = path.join(ztteam_getStorageRoot(), image.video_url.replace(/^[/\\]+/, ''));
        }

        if (fs.existsSync(absoluteVideoPath)) {
          const response = await this.facebookService.ztteam_publishReel(
            page.fb_page_id,
            absoluteVideoPath,
            caption
          );
          fbPostId = response.id;
        } else {
          fbPostId = await this.facebookService.ztteam_publishPhoto(
            page.fb_page_id,
            absoluteImagePath,
            caption
          );
        }
      } else {
        fbPostId = await this.facebookService.ztteam_publishPhoto(
          page.fb_page_id,
          absoluteImagePath,
          caption
        );
      }

      /** ZTTeam: Ngay khi dang thanh cong, gan link vao comment luon neu link_mode khong phai view_threshold */
      let hookCommentId: string | null = null;
      let linkInjected = false;
      if (shouldAttachLinkNow && fbPostId && (image.wp_post_url || image.ai_first_comment)) {
        try {
          const newsComment = ztteam_getNewsComment(image.wp_post_url, image.ai_first_comment);
          if (newsComment) {
            const commentRes = await this.facebookService.ztteam_publishComment(
              page.fb_page_id,
              fbPostId,
              newsComment
            );
            hookCommentId = typeof commentRes === 'object' && commentRes?.id
              ? String(commentRes.id)
              : (typeof commentRes === 'string' ? commentRes : null);
            linkInjected = true;
            this.logger.log(`[Instant News Comment] Successfully posted comment for post ${fbPostId} (Comment ID: ${hookCommentId})`);
          }
        } catch (cmtErr: any) {
          this.logger.error(`[Instant News Comment] Failed to post comment for post ${fbPostId}: ${cmtErr.message}`);
        }
      }

      await this.prisma.ztteam_images.update({
        where: { id: image.id },
        data: {
          is_posted: true,
          posted_at: new Date(),
          fb_post_id: fbPostId,
          status: 'POSTED',
          comment_step: hookCommentId ? 2 : 0,
          hook_comment_id: hookCommentId,
          hook_comment_at: hookCommentId ? new Date() : null,
          link_injected: linkInjected,
          link_injected_at: linkInjected ? new Date() : null,
          link_injected_type: linkInjected ? 'comment' : null,
          post_retry_count: 0,
        }
      });

      await this.prisma.ztteam_image_history.upsert({
        where: {
          page_id_wp_post_id: {
            page_id: page.id,
            wp_post_id: image.wp_post_id,
          }
        },
        create: {
          page_id: page.id,
          wp_post_id: image.wp_post_id,
        },
        update: {},
      }).catch(() => {});

      this.logger.log(`Successfully published image ${image.id} to page ${page.name}, Post ID: ${fbPostId}${hookCommentId ? ' (Instant Comment posted)' : ''}`);
      this.eventEmitter.emit('image.posted', { imageId: image.id, pageId: page.id });
    } catch (error: any) {
      const extractedError = ztteam_extractErrorMessage(error);
      const isIdentityCheckpoint =
        extractedError.includes('4854002') ||
        extractedError.includes('xác nhận danh tính') ||
        extractedError.includes('confirm your identity');

      let currentRetries = (image.post_retry_count || 0) + 1;
      this.logger.error(`Failed to auto-publish image ${image.id} (Attempt ${currentRetries}/3): ${extractedError}`);

      if (isIdentityCheckpoint) {
        /**
         * ZTTeam: Kích hoạt Circuit Breaker ngay lập tức!
         * Meta yêu cầu xác nhận danh tính trên điện thoại.
         * Dừng thử lại ngay (set 3) và tạm dừng auto_publish trên Page để bảo vệ BM và các Page khác.
         */
        currentRetries = 3;
        await this.prisma.ztteam_pages.update({
          where: { id: page.id },
          data: {
            auto_publish_enabled: false,
            token_status: 'checkpoint_required'
          }
        }).catch(() => {});
        this.logger.warn(`[CIRCUIT BREAKER] Page ${page.name} kích hoạt bảo vệ do Facebook yêu cầu xác nhận danh tính. Tạm ngưng auto-publish.`);
      }

      if (currentRetries < 3) {
        await this.prisma.ztteam_images.update({
          where: { id: image.id },
          data: {
            post_retry_count: currentRetries,
            error_log: `Lần thử ${currentRetries}/3 thất bại: ${extractedError}`
          }
        });
        this.logger.log(`Image ${image.id} kept in COMPLETED status for next time slot retry (Attempt ${currentRetries}/3)`);
      } else {
        await this.prisma.ztteam_images.update({
          where: { id: image.id },
          data: {
            status: 'FAILED',
            post_retry_count: currentRetries,
            error_log: isIdentityCheckpoint
              ? `[CIRCUIT BREAKER] Facebook yêu cầu Quản trị viên mở điện thoại xác minh danh tính (Subcode 4854002): ${extractedError}`
              : `Lỗi đăng ảnh sau 3 lần thử: ${extractedError}`
          }
        });

        let ownerEmail = 'N/A';
        if (page?.fb_account?.owner_user_id) {
          const u = await this.prisma.ztteam_users.findUnique({ where: { id: page.fb_account.owner_user_id }, select: { email: true } });
          if (u) ownerEmail = u.email;
        }

        const alertMsg = this.telegramService.ztteam_formatAlert({
          systemName: isIdentityCheckpoint ? 'Xác Minh Danh Tính Fanpage' : 'Xuất Bản Fanpage (Đăng Ảnh 2K)',
          fanpageName: page.name || 'Không rõ',
          postTitle: image.wp_post_title || 'Bài viết ảnh',
          step: 'Đăng tải ảnh 2K và nội dung Caption lên Fanpage Facebook',
          rawError: extractedError,
          nextAction: isIdentityCheckpoint
            ? 'Hệ thống đã tự động tạm ngắt xuất bản trên Page này để bảo vệ BM. Vui lòng mở ứng dụng Facebook trên điện thoại -> Chuyển sang Page -> Đăng thử 1 bài viết để xác nhận danh tính, sau đó bật lại tự động đăng trên web.'
            : 'Đã thử lại 3 lần thất bại. Vui lòng kiểm tra lại token Fanpage hoặc kết nối mạng.',
          memberEmail: ownerEmail,
        });
        this.telegramService.ztteam_sendMessage(alertMsg).catch(() => {});
      }
    }
  }

  /**
   * Helper slugify chuỗi văn bản cho tracking link
   */
  private ztteam_slugify(text: string): string {
    if (!text) return '';
    return text.toString().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-').trim();
  }

  /**
   * Xử lý quy trình comment tự động 2 bước sau khi đăng bài:
   * Bước 1: Sau 60 phút từ posted_at -> Đăng bình luận mồi:
   * "...I know you're all very curious about what happens next, so if you want to read on, leave "YES" in the comments below! 👇"
   * Bước 2: Tương tác thông minh (Smart Engagement):
   * - Trong vòng 2 tiếng (120 phút): Quét mỗi 2 phút, nếu có bất kỳ độc giả thật nào comment -> Reply ngay Part 2 + link cho họ (gửi chuông thông báo).
   * - Nếu sau 2 tiếng vẫn 0 có ai comment: Kích hoạt Fallback tự động reply vào comment mồi của Page để đảm bảo luôn có link bài viết.
   */
  async ztteam_handleDelayedComments() {
    /** ZTTeam: Quy trinh delayed comment 2 buoc da duoc tat hoan toan. Thay the bang Instant Comment ngay khi xuat ban. */
    return;
  }

  async ztteam_handleDelayedComments_deprecated() {
    try {
      const now = new Date();

      /** Bước 1: Quét các bài viết đăng sau 60 phút nhưng chưa đăng comment mồi (comment_step = 0) */
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const step0Images = await this.prisma.ztteam_images.findMany({
        where: {
          is_posted: true,
          fb_post_id: { not: null },
          comment_step: 0,
          posted_at: { gte: oneDayAgo, lte: oneHourAgo }
        },
        include: {
          page: {
            include: { fb_account: true }
          }
        },
        take: 10
      });

      for (const img of step0Images) {
        if (!img.page?.fb_page_id || !img.fb_post_id) continue;

        /** Kiểm tra giãn cách thời gian an toàn nếu đã từng thử thất bại trước đó */
        if (img.post_retry_count > 0) {
          const elapsedMs = now.getTime() - new Date(img.updated_at).getTime();
          /** Lần 1 thất bại -> Chờ ít nhất 5 phút mới thử lần 2. Lần 2 thất bại -> Chờ ít nhất 10 phút mới thử lần 3. */
          const requiredWaitMs = img.post_retry_count === 1 ? 5 * 60 * 1000 : 10 * 60 * 1000;
          if (elapsedMs < requiredWaitMs) {
            const remainingMins = Math.ceil((requiredWaitMs - elapsedMs) / 60000);
            this.logger.log(`[Auto-Comment Step 1] Delay backoff active for image ${img.id} (Attempt ${img.post_retry_count}/3). Waiting ${remainingMins}m before next attempt...`);
            continue;
          }
        }

        try {
          const hookText = ztteam_getRandomHookComment(img.id);
          const res = await this.facebookService.ztteam_publishComment(
            img.page.fb_page_id,
            img.fb_post_id,
            hookText
          );

          const hookCommentId = typeof res === 'object' && res?.id ? String(res.id) : (typeof res === 'string' ? res : null);

          await this.prisma.ztteam_images.update({
            where: { id: img.id },
            data: {
              comment_step: 1,
              hook_comment_id: hookCommentId,
              hook_comment_at: new Date(),
              post_retry_count: 0, /** Reset lại về 0 khi thành công */
            }
          });

          this.logger.log(`[Auto-Comment Step 1] Posted YES hook comment for image ${img.id} (Post ${img.fb_post_id}, Comment ID: ${hookCommentId})`);
        } catch (err: any) {
          const extractedError = ztteam_extractErrorMessage(err);
          const currentRetries = (img.post_retry_count || 0) + 1;
          this.logger.error(`[Auto-Comment Step 1] Failed for image ${img.id} (Attempt ${currentRetries}/3): ${extractedError}`);

          if (currentRetries < 3) {
            /** Tự động giãn cách thời gian để thử lại ở chu kỳ tiếp theo, CHƯA báo Telegram */
            await this.prisma.ztteam_images.update({
              where: { id: img.id },
              data: {
                post_retry_count: currentRetries,
                error_log: `Lần thử ${currentRetries}/3 thất bại: ${extractedError}`,
              }
            }).catch(() => { });
            this.logger.log(`[Auto-Comment Step 1] Image ${img.id} scheduled for safe backoff retry ${currentRetries + 1}/3 after ${currentRetries === 1 ? '5' : '10'} minutes.`);
          } else {
            /** Sau 3 lần thử thất bại: Đánh dấu comment_step = 2 để kết thúc và báo Telegram */
            await this.prisma.ztteam_images.update({
              where: { id: img.id },
              data: {
                comment_step: 2,
                post_retry_count: currentRetries,
                error_log: `Lỗi comment mồi sau 3 lần thử (giãn cách an toàn 5-10 phút): ${extractedError}`,
              }
            }).catch(() => { });

            /** ZTTeam: Bắn thông báo cảnh báo lỗi bình luận Step 1 về Telegram */
            let ownerEmail = 'N/A';
            if (img.page?.fb_account?.owner_user_id) {
              const u = await this.prisma.ztteam_users.findUnique({ where: { id: img.page.fb_account.owner_user_id }, select: { email: true } });
              if (u) ownerEmail = u.email;
            }

            const alertMsg = this.telegramService.ztteam_formatAlert({
              systemName: 'Tự Động Bình Luận (Auto-Comment)',
              fanpageName: img.page?.name || 'Không rõ',
              postTitle: img.wp_post_title || 'Bài viết ảnh 2K',
              step: 'Bước 1: Đăng bình luận mồi (YES Hook Comment) dưới bài viết',
              rawError: extractedError,
              nextAction: 'Đã thử lại 3 lần (giãn cách an toàn 5-10 phút) đều thất bại. Hệ thống kết thúc quy trình để bảo vệ Fanpage.',
              memberEmail: ownerEmail,
            });
            this.telegramService.ztteam_sendMessage(alertMsg).catch(() => {});
          }
        }
      }

      /** Bước 2: Quét các bài viết đang ở comment_step = 1 (Đã đăng comment mồi, chờ độc giả tương tác hoặc fallback sau 5 tiếng) */
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const step1Images = await this.prisma.ztteam_images.findMany({
        where: {
          is_posted: true,
          comment_step: 1,
          hook_comment_id: { not: null },
          hook_comment_at: { gte: threeDaysAgo }
        },
        include: {
          page: {
            include: { fb_account: true }
          }
        },
        take: 10
      });

      for (const img of step1Images) {
        if (!img.page?.fb_page_id || !img.hook_comment_id || !img.hook_comment_at) continue;

        /** Kiểm tra giãn cách thời gian an toàn nếu từng thử thất bại ở Step 2 */
        if (img.post_retry_count > 0) {
          const elapsedMs = now.getTime() - new Date(img.updated_at).getTime();
          const requiredWaitMs = img.post_retry_count === 1 ? 5 * 60 * 1000 : 10 * 60 * 1000;
          if (elapsedMs < requiredWaitMs) {
            continue;
          }
        }

        try {
          const hookAgeMs = now.getTime() - new Date(img.hook_comment_at).getTime();
          const hookAgeMinutes = Math.floor(hookAgeMs / (60 * 1000));
          const isExpired5Hours = hookAgeMinutes >= 300; /** Đủ 5 tiếng (300 phút) */

          /** Chuẩn bị nội dung reply Part 2 + link bài viết */
          let replyContent = img.ai_first_comment;
          if (!replyContent || replyContent === 'NO_LINK') {
            const utmMedium = this.ztteam_slugify(img.page?.fb_account?.name || 'account');
            const utmCampaign = this.ztteam_slugify(img.page?.name || 'page');
            const trackingLink = img.wp_post_url
              ? `${img.wp_post_url}${img.wp_post_url.includes('?') ? '&' : '?'}utm_source=image&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}`
              : '';
            replyContent = `👉 FULL STORY HERE 👇👇👇\n${trackingLink}`;
          }

          if (isExpired5Hours) {
            /** KỊCH BẢN 1: Đã hết 5 tiếng mà không có ai comment -> Kích hoạt Fallback tự động reply vào chính comment mồi */
            await this.facebookService.ztteam_publishComment(
              img.page.fb_page_id,
              img.hook_comment_id,
              replyContent
            );

            await this.prisma.ztteam_images.update({
              where: { id: img.id },
              data: {
                comment_step: 2,
                post_retry_count: 0,
              }
            });

            this.logger.log(`[Auto-Comment Step 2 - Fallback 5h] Replied Part 2 & Link for image ${img.id} to hook comment ${img.hook_comment_id} after ${hookAgeMinutes}m`);
            continue;
          }

          /** KỊCH BẢN 2: Trong vòng 5 tiếng -> Quét mỗi 2 phút một lần để tìm tương tác từ độc giả thật */
          if (hookAgeMinutes % 2 !== 0) {
            /** Chưa đến chu kỳ 2 phút -> Bỏ qua tick này để tiết kiệm API */
            continue;
          }

          /** Gọi Graph API lấy bình luận bài viết (Field expansion kèm reply lồng nhau) */
          const comments = await this.facebookService.ztteam_getComments(
            img.page.fb_page_id,
            img.fb_post_id || img.hook_comment_id
          );

          /** Tìm bình luận từ độc giả thật (không phải do chính Fanpage tự comment) */
          let targetCommentId: string | null = null;
          let realCommenterName = '';

          for (const comment of comments) {
            /** Kiểm tra xem comment cấp 1 có phải của độc giả thật không */
            if (comment.from?.id && comment.from.id !== img.page.fb_page_id && comment.id !== img.hook_comment_id) {
              targetCommentId = comment.id;
              realCommenterName = comment.from?.name || '';
              break;
            }

            /** Kiểm tra các sub-comments (replies) lồng bên trong comment */
            if (comment.comments?.data && Array.isArray(comment.comments.data)) {
              for (const subComment of comment.comments.data) {
                if (subComment.from?.id && subComment.from.id !== img.page.fb_page_id) {
                  targetCommentId = subComment.id;
                  realCommenterName = subComment.from?.name || '';
                  break;
                }
              }
            }

            if (targetCommentId) break;
          }

          /** Nếu tìm thấy độc giả thật bình luận -> Reply ngay cho độc giả đó! */
          if (targetCommentId) {
            await this.facebookService.ztteam_publishComment(
              img.page.fb_page_id,
              targetCommentId,
              replyContent
            );

            await this.prisma.ztteam_images.update({
              where: { id: img.id },
              data: {
                comment_step: 2,
                post_retry_count: 0,
              }
            });

            this.logger.log(`[Auto-Comment Step 2 - Smart Engagement] Found real user (${realCommenterName}) on image ${img.id}! Replied Part 2 to comment ${targetCommentId}`);
          }
        } catch (err: any) {
          const extractedError = ztteam_extractErrorMessage(err);
          const currentRetries = (img.post_retry_count || 0) + 1;
          this.logger.error(`[Auto-Comment Step 2] Failed for image ${img.id} (Attempt ${currentRetries}/3): ${extractedError}`);

          if (currentRetries < 3) {
            await this.prisma.ztteam_images.update({
              where: { id: img.id },
              data: {
                post_retry_count: currentRetries,
                error_log: `Lần thử Step 2 ${currentRetries}/3 thất bại: ${extractedError}`,
              }
            }).catch(() => { });
            this.logger.log(`[Auto-Comment Step 2] Image ${img.id} scheduled for safe backoff retry ${currentRetries + 1}/3 after ${currentRetries === 1 ? '5' : '10'} minutes.`);
          } else {
            /** Sau 3 lần thử thất bại mới kết thúc và báo Telegram */
            await this.prisma.ztteam_images.update({
              where: { id: img.id },
              data: {
                comment_step: 2,
                post_retry_count: currentRetries,
                error_log: `Lỗi reply Part 2 sau 3 lần thử (giãn cách 5-10 phút): ${extractedError}`,
              }
            }).catch(() => { });

            let ownerEmail = 'N/A';
            if (img.page?.fb_account?.owner_user_id) {
              const u = await this.prisma.ztteam_users.findUnique({ where: { id: img.page.fb_account.owner_user_id }, select: { email: true } });
              if (u) ownerEmail = u.email;
            }

            const alertMsg = this.telegramService.ztteam_formatAlert({
              systemName: 'Tự Động Bình Luận (Auto-Comment)',
              fanpageName: img.page?.name || 'Không rõ',
              postTitle: img.wp_post_title || 'Bài viết ảnh 2K',
              step: 'Bước 2: Trả lời bình luận độc giả (kèm Link bài viết Part 2)',
              rawError: extractedError,
              nextAction: 'Đã thử lại 3 lần (giãn cách an toàn 5-10 phút) đều thất bại. Hệ thống đã kết thúc quy trình.',
              memberEmail: ownerEmail,
            });
            this.telegramService.ztteam_sendMessage(alertMsg).catch(() => {});
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error in ztteam_handleDelayedComments: ${error.message}`);
    }
  }
}
