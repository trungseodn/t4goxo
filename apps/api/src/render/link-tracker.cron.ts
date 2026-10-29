import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ZTTeamFacebookService } from '../facebook/facebook.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/**
 * ZTTeam: Cron Worker theo dõi lượt xem Video Reel/Bài viết và tự động kích hoạt gắn link điều hướng
 * Chạy mỗi 5 phút một lần để kiểm tra các bài đăng trong vòng 48 giờ.
 */
@Injectable()
export class ZTTeamLinkViewTrackerCron {
  private readonly logger = new Logger(ZTTeamLinkViewTrackerCron.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookService: ZTTeamFacebookService,
    private readonly httpService: HttpService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async ztteam_handleCron() {
    if (process.env.ENABLE_AUTO_CRON === 'false') {
      return;
    }

    if (this.isRunning) {
      this.logger.warn('[LinkTracker] Tiến trình theo dõi lượt xem đang chạy, bỏ qua nhịp này');
      return;
    }

    this.isRunning = true;

    try {
      /** 1. Lọc tất cả Fanpage đang bật chế độ gắn link theo mốc view */
      const pages = await this.prisma.ztteam_pages.findMany({
        where: {
          is_active: true,
          link_mode: 'view_threshold',
        },
        include: { fb_account: true },
      });

      if (pages.length === 0) {
        return;
      }

      const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        if (!page.page_token_encrypted || !page.fb_page_id) {
          continue;
        }

        /** 2. Tìm tất cả Reel và Ảnh đã xuất bản chưa gắn link trong vòng 48h */
        const [pendingReels, pendingImages] = await Promise.all([
          this.prisma.ztteam_reels.findMany({
            where: {
              page_id: page.id,
              is_posted: true,
              link_injected: false,
              fb_post_id: { not: null },
              posted_at: { gte: fortyEightHoursAgo },
              wp_post_url: { not: null },
            },
          }),
          this.prisma.ztteam_images.findMany({
            where: {
              page_id: page.id,
              is_posted: true,
              link_injected: false,
              fb_post_id: { not: null },
              posted_at: { gte: fortyEightHoursAgo },
              wp_post_url: { not: null },
            },
          }),
        ]);

        const totalPending = pendingReels.length + pendingImages.length;
        if (totalPending === 0) {
          continue;
        }

        this.logger.log(`[LinkTracker] Đang kiểm tra lượt xem cho ${totalPending} bài trên Page "${page.name}" (Ngưỡng: ${page.link_view_threshold || 1000} views)...`);

        /** 3. Truy vấn danh sách video views hàng loạt từ Facebook Graph API (1 request batch) */
        const videoViewsMap: Record<string, number> = {};
        try {
          const vidRes = await firstValueFrom(
            this.httpService.get(
              `https://graph.facebook.com/v21.0/${page.fb_page_id}/videos`,
              {
                params: {
                  fields: 'id,views,video_insights.metric(blue_reels_play_count){values}',
                  limit: 50,
                  access_token: page.page_token_encrypted,
                },
              }
            )
          );

          const videos = vidRes.data?.data || [];
          for (const v of videos) {
            const vViews = Number(v.views) || 0;
            const bluePlays = v.video_insights?.data?.[0]?.values?.[0]?.value || 0;
            const maxViews = Math.max(vViews, Number(bluePlays) || 0);
            if (v.id) {
              videoViewsMap[v.id] = maxViews;
            }
          }
        } catch (vidErr: any) {
          this.logger.warn(`[LinkTracker] Lỗi lấy batch video views cho Page ${page.name}: ${vidErr.response?.data?.error?.message || vidErr.message}`);
        }

        const threshold = page.link_view_threshold || 1000;
        const fallbackHours = page.link_fallback_after_hours !== undefined ? page.link_fallback_after_hours : 12;
        const targetPlacement = (page.link_target_placement as any) || 'comment';

        /** 4. Xử lý các bài Reel */
        for (const reel of pendingReels) {
          const postId = reel.fb_post_id!;
          let views = videoViewsMap[postId] || 0;

          /** Nếu postId có định dạng pageId_videoId, tách lấy videoId */
          if (views === 0 && postId.includes('_')) {
            const shortId = postId.split('_')[1];
            views = videoViewsMap[shortId] || 0;
          }

          const hoursSincePosted = reel.posted_at
            ? (Date.now() - new Date(reel.posted_at).getTime()) / (1000 * 60 * 60)
            : 0;

          const isViewReached = views >= threshold;
          const isFallbackReached = fallbackHours > 0 && hoursSincePosted >= fallbackHours;

          if (isViewReached || isFallbackReached) {
            this.logger.log(
              `[LinkTracker] 🎯 KÍCH HOẠT GẮN LINK cho Reel "${reel.wp_post_title}" (ID: ${postId}) trên Page "${page.name}": Views = ${views}/${threshold}, Giờ đăng = ${hoursSincePosted.toFixed(1)}h (Fallback: ${isFallbackReached})`
            );

            const result = await this.facebookService.ztteam_injectLinkToPost({
              page,
              postId,
              wpPostUrl: reel.wp_post_url!,
              placement: targetPlacement,
              currentCaption: reel.ai_caption || reel.wp_post_title,
              isVideo: true,
              utmSource: 'reel_viral',
            });

            await this.prisma.ztteam_reels.update({
              where: { id: reel.id },
              data: {
                link_injected: result.success,
                link_injected_at: result.success ? new Date() : null,
                link_injected_type: targetPlacement,
                current_views: views,
                last_view_checked_at: new Date(),
              },
            });
          } else if (reel.current_views !== views) {
            /** Cập nhật lượt xem gần nhất khi có thay đổi */
            await this.prisma.ztteam_reels.update({
              where: { id: reel.id },
              data: {
                current_views: views,
                last_view_checked_at: new Date(),
              },
            });
          }
        }

        /** 5. Xử lý các bài Ảnh / Post */
        for (const img of pendingImages) {
          const postId = img.fb_post_id!;
          let views = videoViewsMap[postId] || 0;
          if (views === 0 && postId.includes('_')) {
            const shortId = postId.split('_')[1];
            views = videoViewsMap[shortId] || 0;
          }

          const hoursSincePosted = img.posted_at
            ? (Date.now() - new Date(img.posted_at).getTime()) / (1000 * 60 * 60)
            : 0;

          const isViewReached = views >= threshold;
          const isFallbackReached = fallbackHours > 0 && hoursSincePosted >= fallbackHours;

          if (isViewReached || isFallbackReached) {
            this.logger.log(
              `[LinkTracker] 🎯 KÍCH HOẠT GẮN LINK cho Ảnh "${img.wp_post_title}" (ID: ${postId}) trên Page "${page.name}": Views = ${views}/${threshold}, Giờ đăng = ${hoursSincePosted.toFixed(1)}h (Fallback: ${isFallbackReached})`
            );

            const result = await this.facebookService.ztteam_injectLinkToPost({
              page,
              postId,
              wpPostUrl: img.wp_post_url!,
              placement: targetPlacement,
              currentCaption: img.ai_caption || img.wp_post_title,
              isVideo: !!img.video_url,
              utmSource: 'image_viral',
            });

            await this.prisma.ztteam_images.update({
              where: { id: img.id },
              data: {
                link_injected: result.success,
                link_injected_at: result.success ? new Date() : null,
                link_injected_type: targetPlacement,
                current_views: views,
                last_view_checked_at: new Date(),
              },
            });
          } else if (img.current_views !== views) {
            await this.prisma.ztteam_images.update({
              where: { id: img.id },
              data: {
                current_views: views,
                last_view_checked_at: new Date(),
              },
            });
          }
        }

        /** Giãn cách an toàn 500ms giữa các Fanpage */
        if (i < pages.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } catch (err: any) {
      this.logger.error(`[LinkTracker] Lỗi tiến trình theo dõi lượt xem: ${err.message}`, err.stack);
    } finally {
      this.isRunning = false;
    }
  }
}
