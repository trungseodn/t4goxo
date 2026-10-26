import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZTTeamWordpressService } from '../wordpress/wordpress.service';

/**
 * ZTTeam WordPress Post Auto-Sync Cron
 * Định kỳ quét các bài viết mới nhất trên Website WordPress đã liên kết với Fanpage
 * Tải ảnh chuẩn có sẵn của bài viết và đưa vào hàng đợi Render Video Reel hoàn toàn tự động
 */
@Injectable()
export class ZTTeamImageRenderCron implements OnApplicationBootstrap {
  private readonly logger = new Logger('ZTTeamWpSyncCron');
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wordpressService: ZTTeamWordpressService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.ENABLE_AUTO_CRON === 'false') {
      this.logger.log('WP Auto-Sync Cron is disabled via ENABLE_AUTO_CRON=false');
      return;
    }
    this.logger.log('Application started, triggering initial WP Auto-Sync Cron...');
    this.ztteam_handleCron();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async ztteam_handleCron() {
    if (process.env.ENABLE_AUTO_CRON === 'false') {
      return;
    }
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    try {
      await this.wordpressService.ztteam_syncAllActivePages();
    } catch (err: any) {
      this.logger.error(`WP Auto-Sync Cron failed: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

