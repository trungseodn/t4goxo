import { Body, Controller, Post, Get, Param, UseGuards, Request, Put, Delete, UseInterceptors, UploadedFile, UploadedFiles } from '@nestjs/common';
import { FileInterceptor, FileFieldsInterceptor } from '@nestjs/platform-express';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
const { diskStorage } = require('multer');
import { ZTTeamFacebookService } from './facebook.service';
import { ZTTeamAuthGuard } from '../auth/auth.guard';
import { ztteam_getStorageRoot } from '../common/ztteam_storage.util';

@Controller('facebook')
@UseGuards(ZTTeamAuthGuard)
export class ZTTeamFacebookController {
  constructor(private facebookService: ZTTeamFacebookService) {}

  @Post('exchange-token')
  ztteam_exchangeToken(@Body() body: { shortToken: string }, @Request() req: any) {
    console.log('--- FB EXCHANGE TOKEN CALLED ---', body, req.user);
    return this.facebookService.ztteam_exchangeLongLivedToken(body.shortToken, req.user.sub);
  }

  @Post('connect-bm-token')
  ztteam_connectBMToken(@Body() body: { token: string }, @Request() req: any) {
    return this.facebookService.ztteam_connectBMToken(body.token, req.user.sub);
  }

  @Get('businesses')
  ztteam_getBusinesses(@Request() req: any) {
    return this.facebookService.ztteam_getBusinessesWithAssets(req.user.sub);
  }

  @Post('pages/:fbAccountId/fetch')
  ztteam_fetchPages(@Param('fbAccountId') fbAccountId: string, @Request() req: any) {
    return this.facebookService.ztteam_fetchPages(fbAccountId, req.user.sub);
  }

  @Get('pages')
  ztteam_getPages(@Request() req: any) {
    return this.facebookService.ztteam_getConnectedPages(req.user.sub);
  }

  @Post('pages/bulk-assign-sources')
  ztteam_bulkAssignSources(
    @Body() body: {
      pageIds: string[];
      targetSiteId: string;
      targetCategoryId?: string | null;
      mode?: 'replace' | 'append';
    },
    @Request() req: any
  ) {
    return this.facebookService.ztteam_bulkAssignSources(req.user.sub, body);
  }

  @Post('pages/bulk-apply-schedule')
  ztteam_bulkApplySchedule(
    @Body()
    body: {
      pageIds: string[];
      postsPerDay?: number;
      customTimes?: string[];
      postFormat?: 'image' | 'reel' | 'mixed';
      videoEngine?: 'hook_image' | 'text_story' | 'muse';
      defaultBgm?: string;
      autoPublishEnabled?: boolean;
      linkMode?: 'instant' | 'view_threshold' | 'disabled';
      linkViewThreshold?: number;
      linkTargetPlacement?: 'comment' | 'caption' | 'both';
      linkFallbackAfterHours?: number;
    },
    @Request() req: any
  ) {
    return this.facebookService.ztteam_bulkApplySchedule(req.user.sub, body);
  }

  @Post('pages/:pageId/test-post')
  ztteam_testPost(@Param('pageId') pageId: string, @Body() body: { message: string }, @Request() req: any) {
    return this.facebookService.ztteam_testPost(pageId, req.user.sub, body.message);
  }

  @Put('pages/:pageId/settings')
  ztteam_updatePageSettings(@Param('pageId') pageId: string, @Body() body: any, @Request() req: any) {
    return this.facebookService.ztteam_updatePageSettings(pageId, req.user.sub, body);
  }

  @Get('pages/:pageId/settings')
  ztteam_getPageSettings(@Param('pageId') pageId: string, @Request() req: any) {
    return this.facebookService.ztteam_getPageSettings(pageId, req.user.sub);
  }

  @Get('pages/:pageId/report')
  ztteam_getPageReport(@Param('pageId') pageId: string, @Request() req: any) {
    return this.facebookService.ztteam_getPageInsights(pageId, req.user.sub);
  }

  @Get('pages/:pageId/top-posts')
  ztteam_getTopPosts(@Param('pageId') pageId: string, @Request() req: any) {
    return this.facebookService.ztteam_getTopPosts(pageId, req.user.sub);
  }

  @Delete('pages/:pageId')
  ztteam_deletePage(@Param('pageId') pageId: string, @Request() req: any) {
    return this.facebookService.ztteam_deletePage(pageId, req.user.sub);
  }

  @Put('pages/:pageId/toggle-active')
  ztteam_togglePageActive(@Param('pageId') pageId: string, @Body() body: { isActive: boolean }, @Request() req: any) {
    return this.facebookService.ztteam_togglePageActive(pageId, req.user.sub, body.isActive);
  }

  @Get('accounts')
  ztteam_getAccounts(@Request() req: any) {
    return this.facebookService.ztteam_getConnectedAccounts(req.user.sub);
  }

  @Delete('accounts/:accountId')
  ztteam_deleteAccount(@Param('accountId') accountId: string, @Request() req: any) {
    return this.facebookService.ztteam_deleteAccount(accountId, req.user.sub);
  }

  @Post('accounts/check-health')
  ztteam_checkAllAccountsHealth(@Request() req: any) {
    return this.facebookService.ztteam_checkAccountHealth(req.user.sub);
  }

  @Post('accounts/:accountId/check-health')
  ztteam_checkSingleAccountHealth(@Param('accountId') accountId: string, @Request() req: any) {
    return this.facebookService.ztteam_checkAccountHealth(req.user.sub, accountId);
  }

  @Post('pages/:pageId/posts/:postId/auto-comment')
  async autoComment(
    @Param('pageId') pageId: string,
    @Param('postId') postId: string,
    @Request() req: any,
    @Body('manualLink') manualLink?: string
  ) {
    return this.facebookService.ztteam_autoCommentLink(pageId, postId, manualLink);
  }

  @Post('pages/branding/bulk-queue')
  ztteam_queueBrandingJobs(@Request() req: any, @Body() body: any) {
    return this.facebookService.ztteam_queueBrandingJobs(req.user.sub, body);
  }

  @Get('pages/branding/pending-job')
  ztteam_getPendingBrandingJob() {
    return this.facebookService.ztteam_getPendingBrandingJob();
  }

  @Get('pages/branding/queue-status')
  ztteam_getBrandingQueueStatus() {
    return this.facebookService.ztteam_getBrandingQueueStatus();
  }

  @Post('pages/branding/:pageId/reset')
  ztteam_resetBrandingJob(@Param('pageId') pageId: string) {
    return this.facebookService.ztteam_resetBrandingJob(pageId);
  }

  @Post('pages/branding/:pageId/attach-result')
  @UseInterceptors(FileFieldsInterceptor([
    { name: 'avatar', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ], {
    storage: diskStorage({
      destination: (req: any, file: any, cb: any) => {
        const brandingPath = path.join(ztteam_getStorageRoot(), 'branding');
        if (!fs.existsSync(brandingPath)) {
          fs.mkdirSync(brandingPath, { recursive: true });
        }
        cb(null, brandingPath);
      },
      filename: (req: any, file: any, cb: any) => {
        const safeId = (req.params.pageId || 'brand').replace(/[^a-zA-Z0-9_-]/g, '');
        const ext = path.extname(file.originalname) || '.png';
        cb(null, `muse_${file.fieldname}_${safeId}_${Date.now()}${ext}`);
      }
    })
  }))
  async ztteam_attachBrandingResult(
    @Param('pageId') pageId: string,
    @UploadedFiles() files: { avatar?: any[]; cover?: any[] },
    @Body() body: any
  ) {
    return this.facebookService.ztteam_attachBrandingResult(pageId, {
      avatarFile: files?.avatar?.[0],
      coverFile: files?.cover?.[0],
      avatarUrl: body?.avatarUrl,
      coverUrl: body?.coverUrl,
      error: body?.error,
    });
  }

  @Post('pages/branding/batch-generate')
  ztteam_batchGenerateBranding(
    @Body() body: { limit?: number; overwriteExisting?: boolean; pageIds?: string[] }
  ) {
    return this.facebookService.ztteam_batchGenerateBranding(body || {});
  }

  @Post('pages/branding/batch-apply')
  ztteam_batchApplyBranding(
    @Body() body: { pageIds?: string[]; delayMs?: number }
  ) {
    return this.facebookService.ztteam_batchApplyBranding(body || {});
  }

  @Post('pages/:pageId/branding/generate')
  ztteam_generateBranding(@Param('pageId') pageId: string) {
    return this.facebookService.ztteam_generatePageBranding(pageId);
  }

  @Post('pages/:pageId/branding/regenerate-item')
  ztteam_regenerateBrandingItem(
    @Param('pageId') pageId: string,
    @Body() body: { type: 'avatar' | 'cover'; prompt?: string }
  ) {
    return this.facebookService.ztteam_regenerateBrandingItem(pageId, body.type, body.prompt);
  }

  @Post('pages/:pageId/branding/apply')
  ztteam_applyBranding(
    @Param('pageId') pageId: string,
    @Body() body: {
      avatarUrl?: string;
      coverUrl?: string;
      avatarLocalPath?: string;
      coverLocalPath?: string;
    }
  ) {
    return this.facebookService.ztteam_applyPageBranding(pageId, body);
  }

  @Post('pages/bulk-update-category')
  ztteam_bulkUpdateCategory(
    @Body()
    body: {
      pageIds: string[];
      categoryId: string;
      categoryName: string;
    }
  ) {
    return this.facebookService.ztteam_bulkUpdateCategory(body);
  }

  @Post('pages/:pageId/branding/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: os.tmpdir(),
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
    })
  )
  ztteam_uploadBrandingAsset(
    @Param('pageId') pageId: string,
    @UploadedFile() file: any,
    @Body('type') type: 'avatar' | 'cover',
  ) {
    return this.facebookService.ztteam_uploadBrandingAsset(pageId, file, type);
  }
}

