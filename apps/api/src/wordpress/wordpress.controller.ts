import { Controller, Post, Get, Delete, Patch, Body, Param, UseGuards, Request, Query } from '@nestjs/common';
import { ZTTeamWordpressService } from './wordpress.service';
import { ZTTeamAuthGuard } from '../auth/auth.guard';

@Controller('wordpress')
@UseGuards(ZTTeamAuthGuard)
export class ZTTeamWordpressController {
  constructor(private readonly wordpressService: ZTTeamWordpressService) {}

  @Post('test-connection')
  ztteam_testConnection(@Body() body: { wpUrl: string; wpUsername: string; wpAppPassword: string }) {
    return this.wordpressService.ztteam_testConnection(body.wpUrl, body.wpUsername, body.wpAppPassword);
  }

  @Post('sites')
  ztteam_createSite(@Body() body: { wpUrl: string; wpUsername: string; wpAppPassword: string; isManual?: boolean; ga4PropertyId?: string }, @Request() req: any) {
    return this.wordpressService.ztteam_createTargetSite(req.user.sub, body);
  }

  @Get('sites')
  ztteam_getSites(@Request() req: any) {
    return this.wordpressService.ztteam_getTargetSites(req.user.sub);
  }

  @Patch('sites/:id')
  ztteam_updateSite(@Param('id') id: string, @Body() body: { wpUrl: string; wpUsername: string; wpAppPassword?: string; isManual?: boolean; ga4PropertyId?: string }, @Request() req: any) {
    return this.wordpressService.ztteam_updateTargetSite(req.user.sub, id, body);
  }

  @Patch('sites/:id/toggle-manual')
  ztteam_toggleSiteManual(@Param('id') id: string, @Body() body: { isManual: boolean }, @Request() req: any) {
    return this.wordpressService.ztteam_toggleSiteManual(req.user.sub, id, body.isManual);
  }

  @Delete('sites/:id')
  ztteam_deleteSite(@Param('id') id: string, @Request() req: any) {
    return this.wordpressService.ztteam_deleteTargetSite(req.user.sub, id);
  }

  @Post('sites/:siteId/test-post')
  ztteam_testPost(@Param('siteId') siteId: string, @Body() body: { title: string; content: string; excerpt?: string; imageUrl?: string }) {
    return this.wordpressService.ztteam_createPost(siteId, body);
  }

  @Get('sites/:siteId/categories')
  ztteam_getCategories(@Param('siteId') siteId: string, @Request() req: any) {
    return this.wordpressService.ztteam_getCategories(siteId, req.user.sub);
  }

  @Get('sites/:siteId/tags')
  ztteam_getTags(@Param('siteId') siteId: string, @Request() req: any) {
    return this.wordpressService.ztteam_getTags(siteId, req.user.sub);
  }

  @Get('sites/:siteId/posts')
  ztteam_getPosts(
    @Param('siteId') siteId: string, 
    @Request() req: any,
    @Query('categoryId') categoryId?: string,
    @Query('targetTags') targetTags?: string
  ) {
    return this.wordpressService.ztteam_getPosts(siteId, req.user.sub, categoryId, targetTags);
  }

  @Get('sites/:siteId/sample-post')
  ztteam_getSamplePost(
    @Param('siteId') siteId: string, 
    @Request() req: any,
    @Query('categoryId') categoryId?: string,
    @Query('targetTags') targetTags?: string
  ) {
    return this.wordpressService.ztteam_getSamplePost(siteId, req.user.sub, categoryId, targetTags);
  }

  @Post('sync-page-posts/:pageId')
  ztteam_syncPagePosts(
    @Param('pageId') pageId: string,
    @Body() body: { maxBatch?: number },
    @Request() req: any
  ) {
    return this.wordpressService.ztteam_syncPostsForPage(pageId, {
      maxBatch: body?.maxBatch,
      forceSync: true,
      userId: req.user.sub
    });
  }

  @Post('sites/:siteId/sync-posts')
  ztteam_syncSitePosts(
    @Param('siteId') siteId: string,
    @Body() body: { categoryId?: string; targetTags?: string; maxBatch?: number },
    @Request() req: any
  ) {
    return this.wordpressService.ztteam_syncPostsForSite(siteId, req.user.sub, body);
  }

  @Post('bulk-sync-pages')
  ztteam_bulkSyncPages(
    @Body() body: { scope?: 'selected' | 'bm' | 'all'; pageIds?: string[]; bmName?: string; maxBatch?: number },
    @Request() req: any
  ) {
    return this.wordpressService.ztteam_bulkSyncPages(req.user.sub, body);
  }
}
