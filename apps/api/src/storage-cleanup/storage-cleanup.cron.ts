import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { ztteam_getReelsPath, ztteam_getImagesPath, ztteam_getVideosPath } from '../common/ztteam_storage.util';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ZTTeamStorageCleanupCron {
  private readonly logger = new Logger(ZTTeamStorageCleanupCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
  ) {}

  /** Run every day at 02:00 AM */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async ztteam_handleCron() {
    this.logger.log('Starting daily storage cleanup...');
    try {
      /** Fetch retention days from settings */
      const setting = await this.prisma.ztteam_settings.findUnique({ where: { key: 'video_retention_days' } });
      const retentionDays = setting ? parseInt(setting.value, 10) : 7;
      
      if (isNaN(retentionDays) || retentionDays <= 0) {
        this.logger.log('Retention days is invalid or disabled. Skipping cleanup.');
        return;
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      this.logger.log(`Cleaning up files older than ${retentionDays} days (before ${cutoffDate.toISOString()})`);

      let deletedVideosCount = 0;
      let deletedImagesCount = 0;
      let deletedReelsCount = 0;

      /** 1. Cleanup old posted videos and images from ztteam_images */
      const oldPostedImages = await this.prisma.ztteam_images.findMany({
        where: {
          created_at: { lt: cutoffDate },
          is_posted: true,
          OR: [
            { video_url: { not: 'DELETED' } },
            { image_url: { not: 'DELETED' } },
          ],
        },
        select: { id: true, video_url: true, image_url: true },
      });

      for (const item of oldPostedImages) {
        // Delete video file if exists
        if (item.video_url && item.video_url !== 'DELETED') {
          const videoFilename = path.basename(item.video_url);
          const videoPath = path.join(ztteam_getVideosPath(), videoFilename);
          if (fs.existsSync(videoPath)) {
            try {
              fs.unlinkSync(videoPath);
              deletedVideosCount++;
            } catch (e) {}
          }
        }

        // Delete image directory if exists
        if (item.image_url && item.image_url !== 'DELETED') {
          const itemDir = ztteam_getImagesPath(item.id);
          if (fs.existsSync(itemDir)) {
            try {
              fs.rmSync(itemDir, { recursive: true, force: true });
              deletedImagesCount++;
            } catch (e) {}
          }
        }
      }

      if (oldPostedImages.length > 0) {
        await this.prisma.ztteam_images.updateMany({
          where: {
            id: { in: oldPostedImages.map((i) => i.id) },
          },
          data: {
            video_url: 'DELETED',
            image_url: 'DELETED',
          },
        });
      }

      /** 2. Cleanup legacy Reels (ztteam_reels) */
      const oldReels = await this.prisma.ztteam_reels.findMany({
        where: {
          created_at: { lt: cutoffDate },
          is_posted: true,
          video_url: { not: 'DELETED' },
        },
      });

      for (const reel of oldReels) {
        const reelDir = ztteam_getReelsPath(reel.id);
        if (fs.existsSync(reelDir)) {
          const files = fs.readdirSync(reelDir);
          for (const file of files) {
            if (file.match(/\.(mp4|webm|mkv|mp3|m4a|wav)$/i)) {
              try {
                fs.unlinkSync(path.join(reelDir, file));
              } catch (e) {}
            }
          }
        }
        await this.prisma.ztteam_reels.update({
          where: { id: reel.id },
          data: { video_url: 'DELETED' },
        });
        deletedReelsCount++;
      }

      this.logger.log(`Cleanup complete. Deleted ${deletedVideosCount} videos, ${deletedImagesCount} images, ${deletedReelsCount} legacy reels.`);
      
      if (deletedVideosCount > 0 || deletedImagesCount > 0 || deletedReelsCount > 0) {
        this.telegramService.ztteam_sendMessage(
          `🧹 *[DỌN DẸP Ổ CỨNG ĐỊNH KỲ]*\n\n` +
          `Đã xóa tự động các file video/ảnh cũ hơn ${retentionDays} ngày:\n` +
          `• Video đã đăng: ${deletedVideosCount + deletedReelsCount} file\n` +
          `• Thư mục ảnh đã đăng: ${deletedImagesCount} mục`
        );
      }

    } catch (error: any) {
      this.logger.error(`Storage cleanup failed: ${error.message}`);
      this.telegramService.ztteam_sendMessage(
        `🚨 *[LỖI DỌN DẸP Ổ CỨNG]*\n\n` +
        `• *Lỗi:* ${error.message}`
      );
    }
  }
}
