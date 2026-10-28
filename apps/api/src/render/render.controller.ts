import { Controller, Get, Post, Param, Body, Query, UseGuards, Sse, MessageEvent, Header, Request } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ZTTeamAuthGuard } from '../auth/auth.guard';
import { ZTTeamRenderProcessor } from './render.processor';
import { PrismaService } from '../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent } from 'rxjs';
import { map } from 'rxjs/operators';
import { ZTTeamFacebookService } from '../facebook/facebook.service';
import { ztteam_getReelsPath } from '../common/ztteam_storage.util';
import { ztteam_getNewsComment } from '../common/ztteam_news_comment.util';

/**
 * ZTTeamRenderController — API endpoints for managing reel rendering.
 */
@Controller('render')
export class ZTTeamRenderController {
  constructor(
    private readonly renderProcessor: ZTTeamRenderProcessor,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly facebookService: ZTTeamFacebookService,
  ) {}

  /**
   * SSE endpoint for live updates. No auth guard so the browser EventSource can connect easily.
   */
  @Sse('events')
  @Header('Cache-Control', 'no-cache')
  @Header('X-Accel-Buffering', 'no')
  ztteam_renderEvents(): Observable<MessageEvent> {
    return fromEvent(this.eventEmitter, 'reel.updated').pipe(
      map((payload) => {
        return { data: payload } as MessageEvent;
      }),
    );
  }

  /**
   * Create a new render job.
   * Creates a reel record in DB then enqueues the job.
   */
  @Post('create')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_createRenderJob(
    @Body() body: { pageId: string; wpPostId: string; wpPostTitle: string; wpPostUrl?: string; templateId: string },
  ) {
    /** Find the internal page ID from fb_page_id */
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { fb_page_id: body.pageId }
    });
    
    if (!page) {
      return { error: 'Không tìm thấy Fanpage', code: 'NOT_FOUND' };
    }

    /** Kiểm tra xem bài viết đã từng được sử dụng trên BẤT KỲ Fanpage nào trong hệ thống hay chưa */
    const postWpIdStr = body.wpPostId.toString();
    const postTitleTrimmed = (body.wpPostTitle || '').trim();

    const existingInReels = await this.prisma.ztteam_reels.findFirst({
      where: {
        OR: [
          { wp_post_id: postWpIdStr },
          ...(postTitleTrimmed ? [{ wp_post_title: postTitleTrimmed }] : []),
          ...(body.wpPostUrl ? [{ wp_post_url: body.wpPostUrl }] : [])
        ]
      },
      include: { page: true }
    });
    if (existingInReels) {
      return {
        error: `Bài viết này đã tồn tại trong hàng đợi Reel (thuộc Page "${existingInReels.page?.name || existingInReels.page_id}"). Tuyệt đối không tạo trùng lặp.`,
        code: 'DUPLICATE'
      };
    }

    const existingInReelHistory = await this.prisma.ztteam_reel_history.findFirst({
      where: { wp_post_id: postWpIdStr },
      include: { page: true }
    });
    if (existingInReelHistory) {
      return {
        error: `Bài viết này đã từng được tạo Reel cho Page "${existingInReelHistory.page?.name || existingInReelHistory.page_id}". Tuyệt đối không tạo trùng lặp.`,
        code: 'DUPLICATE'
      };
    }

    const existingInImages = await this.prisma.ztteam_images.findFirst({
      where: {
        OR: [
          { wp_post_id: postWpIdStr },
          ...(postTitleTrimmed ? [{ wp_post_title: postTitleTrimmed }] : []),
          ...(body.wpPostUrl ? [{ wp_post_url: body.wpPostUrl }] : [])
        ]
      },
      include: { page: true }
    });
    if (existingInImages) {
      return {
        error: `Bài viết này đã tồn tại trong hàng đợi Bài viết (thuộc Page "${existingInImages.page?.name || existingInImages.page_id}"). Tuyệt đối không tạo trùng lặp.`,
        code: 'DUPLICATE'
      };
    }

    const existingInImageHistory = await this.prisma.ztteam_image_history.findFirst({
      where: { wp_post_id: postWpIdStr },
      include: { page: true }
    });
    if (existingInImageHistory) {
      return {
        error: `Bài viết này đã từng được dùng cho Page "${existingInImageHistory.page?.name || existingInImageHistory.page_id}". Tuyệt đối không tạo trùng lặp.`,
        code: 'DUPLICATE'
      };
    }

    /** Create the reel record */
    const reel = await this.prisma.ztteam_reels.create({
      data: {
        page_id: page.id,
        wp_post_id: body.wpPostId,
        wp_post_title: body.wpPostTitle,
        wp_post_url: body.wpPostUrl,
        template_id: body.templateId,
        status: 'QUEUED',
        progress: 0,
      },
    });

    /** Mark post as used IMMEDIATELY to prevent duplicates */
    await this.prisma.ztteam_reel_history.upsert({
      where: { page_id_wp_post_id: { page_id: page.id, wp_post_id: body.wpPostId } },
      create: { page_id: page.id, wp_post_id: body.wpPostId },
      update: {},
    });

    /** Enqueue the job */
    await this.renderProcessor.ztteam_addJob({
      reelId: reel.id,
      pageId: page.id,
      wpPostId: body.wpPostId,
      wpPostTitle: body.wpPostTitle,
      templateId: body.templateId,
    });

    return { reelId: reel.id, status: 'QUEUED', message: 'Đã thêm vào hàng đợi render' };
  }

  /**
   * Get status of a specific reel.
   */
  @Get('status/:id')
  async ztteam_getReelStatus(@Param('id') id: string) {
    const reel = await this.prisma.ztteam_reels.findUnique({
      where: { id },
      include: { page: { select: { name: true, avatar: true } } },
    });

    if (!reel) {
      return { error: 'Reel không tồn tại' };
    }

    return reel;
  }

  /**
   * List all reels with optional filters.
   */
  @Get('list')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_listReels(
    @Request() req: any,
    @Query('pageId') pageId?: string,
    @Query('fbPageId') fbPageId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const take = parseInt(limit || '20', 10);
    const skip = ((parseInt(page || '1', 10) - 1)) * take;

    const where: any = {
      source_type: { not: 'TIKTOK_CLONE' }
    };
    if (pageId) where.page_id = pageId;
    if (fbPageId) where.page = { ...where.page, fb_page_id: fbPageId };
    if (status) where.status = status;

    /** Lọc dữ liệu theo User đang đăng nhập (chặn Manager xem của Admin) */
    where.page = {
      ...where.page,
      fb_account: {
        owner_user_id: req.user.sub
      }
    };

    const [reels, total] = await Promise.all([
      this.prisma.ztteam_reels.findMany({
        where,
        orderBy: { updated_at: 'desc' },
        take,
        skip,
        include: { 
          page: { 
            select: { 
              name: true, 
              avatar: true, 
              fb_page_id: true,
              add_link_to_caption: true,
              add_link_to_comment: true,
              fb_account: { select: { name: true } }
            } 
          } 
        },
      }),
      this.prisma.ztteam_reels.count({ where }),
    ]);

    const slugify = (text: string) => {
      if (!text) return '';
      return text.toString().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-').trim();
    };

    /** Fetch last posted items for scheduling calculation */
    const pageIds = [...new Set(reels.map(r => r.page_id))];
    const lastPostedReels = await this.prisma.ztteam_reels.findMany({
      where: { page_id: { in: pageIds }, status: 'POSTED' },
      orderBy: { posted_at: 'desc' },
      distinct: ['page_id']
    });
    const lastPostedImages = await this.prisma.ztteam_images.findMany({
      where: { page_id: { in: pageIds }, is_posted: true },
      orderBy: { posted_at: 'desc' },
      distinct: ['page_id']
    });
    
    const lastPostedMap = new Map<string, Date>();
    for (const r of lastPostedReels) lastPostedMap.set(r.page_id, r.posted_at || r.updated_at);
    for (const img of lastPostedImages) {
      if (img.page_id && img.posted_at) {
        const existing = lastPostedMap.get(img.page_id);
        if (!existing || img.posted_at > existing) {
          lastPostedMap.set(img.page_id, img.posted_at);
        }
      }
    }
    /** Simulate queue to get precise scheduled times for all pending reels */
    const allPending = await this.prisma.ztteam_reels.findMany({
       where: { status: { in: ['QUEUED', 'RENDERING', 'COMPLETED'] }, is_posted: false },
       orderBy: { created_at: 'asc' },
       include: { page: true }
    });
    
    const pageNextTimeMap = new Map<string, Date | null>();
    const reelScheduledTimeMap = new Map<string, Date | null>();
    const ztteam_now = new Date();

    for (const pending of allPending) {
       const pageId = pending.page_id;
       const p = pending.page as any;
       if (!p) continue;

       let baseTime = pageNextTimeMap.get(pageId);
       if (!baseTime) {
         const lastPost = lastPostedMap.get(pageId);
         /** ZTTeam: Nếu bài đăng gần nhất đã ở quá khứ hoặc chưa có, mốc tính bắt buộc phải từ thời điểm hiện tại trở đi */
         baseTime = (lastPost && lastPost.getTime() > ztteam_now.getTime()) ? lastPost : ztteam_now;
       } else if (baseTime.getTime() < ztteam_now.getTime()) {
         baseTime = ztteam_now;
       }

       let scheduledAt: Date | null = null;

       if (p.auto_publish_enabled === false) {
         scheduledAt = null;
       } else if (p.schedule_mode === 'fixed') {
         const times = (p.schedule_fixed_times || []).slice();
         if (times.length > 0) {
           times.sort();
           let found = false;

           /** ZTTeam: Lấy ngày, tháng, năm của baseTime theo múi giờ chuẩn Việt Nam (Asia/Ho_Chi_Minh - UTC+7) */
           const vnBaseDateParts = new Intl.DateTimeFormat('en-US', {
             timeZone: 'Asia/Ho_Chi_Minh',
             year: 'numeric',
             month: 'numeric',
             day: 'numeric',
           }).formatToParts(baseTime);

           const vnYear = parseInt(vnBaseDateParts.find(pt => pt.type === 'year')?.value || '2026', 10);
           const vnMonth = parseInt(vnBaseDateParts.find(pt => pt.type === 'month')?.value || '1', 10) - 1;
           const vnDay = parseInt(vnBaseDateParts.find(pt => pt.type === 'day')?.value || '1', 10);

           for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
             for (const time of times) {
               const [h, m] = time.split(':').map(Number);
               /** ZTTeam: Múi giờ Việt Nam là UTC+7, nên giờ UTC = h - 7 */
               const utcTimestamp = Date.UTC(vnYear, vnMonth, vnDay + dayOffset, h - 7, m, 0, 0);
               const testDate = new Date(utcTimestamp);

               if (testDate.getTime() > baseTime.getTime() && testDate.getTime() > ztteam_now.getTime()) {
                 scheduledAt = testDate;
                 found = true;
                 break;
               }
             }
             if (found) break;
           }
         } else {
           scheduledAt = null;
         }
       } else if (p.schedule_mode === 'immediate') {
         const gap = p.schedule_immediate_gap_minutes || 0;
         const diff = gap * 60000;
         const candidate = new Date(baseTime.getTime() + diff);
         scheduledAt = candidate.getTime() > ztteam_now.getTime() ? candidate : ztteam_now;
       } else {
         scheduledAt = null;
       }

       reelScheduledTimeMap.set(pending.id, scheduledAt);
       if (scheduledAt) {
         pageNextTimeMap.set(pageId, scheduledAt);
       }
    }

    /** Generate final_caption dynamically for UI preview and add timestamps */
    const reelsWithDetails = reels.map(r => {
      let finalCaption = r.ai_caption || r.wp_post_title || '';
      let finalComment = null;

      /** Clean up any old tracking links that might have been baked into the database */
      if (finalCaption.includes('utm_source=reel')) {
        const parts = finalCaption.split(/(👉|🔥|📌|👇|🔗|Read more:)/);
        if (parts.length > 1) {
          finalCaption = parts[0].trim();
        } else {
          finalCaption = finalCaption.split(/\n\n.*utm_source=reel/)[0].trim();
        }
      }
      
      const utmMedium = slugify(r.page?.fb_account?.name || 'account');
      const utmCampaign = slugify(r.page?.name || 'page');
      const trackingLink = r.wp_post_url ? `${r.wp_post_url}${r.wp_post_url.includes('?') ? '&' : '?'}utm_source=reel&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}` : '';
      
      if (r.wp_post_url && r.page?.add_link_to_caption) {
        const prefixes = [
          '👉 Discover more here:',
          '🔥 Read the full story:',
          '📌 Check out the details:',
          '👇 Full article link:',
          '🔗 Learn more at:'
        ];
        const prefixIndex = r.id.charCodeAt(r.id.length - 1) % prefixes.length;
        const prefix = prefixes[prefixIndex];
        finalCaption = `${prefix} ${trackingLink}\n\n${finalCaption}`;
      }
      
      if (r.wp_post_url && r.page?.add_link_to_comment) {
        const commentPrefixes = [
          '👉 Discover more here:',
          '🔥 Read the full story:',
          '📌 Check out the details:',
          '👇 Full article link:',
          '🔗 Learn more at:'
        ];
        const prefixIndex = r.id.charCodeAt(r.id.length - 2) % commentPrefixes.length;
        finalComment = `${commentPrefixes[prefixIndex]} ${trackingLink}`;
      }

      let posted_at = null;
      let scheduled_at = null;

      if (r.status === 'POSTED') {
        posted_at = r.updated_at;
      } else if (!r.is_posted) {
        const val = reelScheduledTimeMap.get(r.id);
        scheduled_at = val !== undefined ? val : null;
      }

      return { ...r, final_caption: finalCaption, final_comment: finalComment, posted_at, scheduled_at };
    });

    return { reels: reelsWithDetails, total, page: parseInt(page || '1', 10), limit: take };
  }

  /**
   * Retry a failed reel render.
   */
  @Post('retry/:id')
  async ztteam_retryRender(@Param('id') id: string) {
    const reel = await this.prisma.ztteam_reels.findUnique({ where: { id } });
    if (!reel) return { error: 'Reel không tồn tại' };
    if (reel.status !== 'FAILED' && reel.status !== 'COMPLETED') return { error: 'Chỉ có thể tạo lại reel bị lỗi hoặc đã hoàn thành' };

    /** Reset status and re-enqueue */
    await this.prisma.ztteam_reels.update({
      where: { id },
      data: { status: 'QUEUED', progress: 0, error_log: null },
    });

    await this.renderProcessor.ztteam_addJob({
      reelId: reel.id,
      pageId: reel.page_id,
      wpPostId: reel.wp_post_id,
      wpPostTitle: reel.wp_post_title,
      templateId: reel.template_id,
    });

    return { reelId: reel.id, status: 'QUEUED', message: 'Đã thêm lại vào hàng đợi' };
  }

  /**
   * Delete a reel record and its files.
   */
  @Post('delete/:id')
  async ztteam_deleteReel(@Param('id') id: string) {
    const reel = await this.prisma.ztteam_reels.findUnique({ where: { id } });
    if (!reel) return { error: 'Reel không tồn tại' };

    /** Delete physical files if they exist */
    const fs = require('fs');
    
    try {
      const reelDir = ztteam_getReelsPath(id);
      if (fs.existsSync(reelDir)) {
        fs.rmSync(reelDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error('Error deleting files', e);
    }

    /** Delete reel record */
    await this.prisma.ztteam_reels.delete({ where: { id } });

    /** Also delete from history so it can be recreated */
    try {
      await this.prisma.ztteam_reel_history.deleteMany({
        where: { page_id: reel.page_id, wp_post_id: reel.wp_post_id }
      });
    } catch (e) {
      console.error('Error deleting reel history', e);
    }

    return { message: 'Đã xóa reel thành công' };
  }

  /**
   * Post a completed reel to Facebook.
   */
  @Post('post/:id')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_postReelToFacebook(@Param('id') id: string) {
    const reel = await this.prisma.ztteam_reels.findUnique({
      where: { id },
      include: { page: true }
    });

    if (!reel) return { error: 'Reel không tồn tại' };
    if (reel.status !== 'COMPLETED') return { error: 'Chỉ có thể đăng Reel đã hoàn thành' };

    const fs = require('fs');
    const videoPath = ztteam_getReelsPath(reel.id, 'output.mp4');
    
    if (!fs.existsSync(videoPath)) {
      return { error: 'File video không tồn tại trên server' };
    }

    try {
      let description = reel.ai_caption || reel.wp_post_title || '';
      let trackingLinkManual = '';
      
      /** Clean up any old tracking links that might have been baked into the database */
      if (description.includes('utm_source=reel')) {
        const parts = description.split(/(👉|🔥|📌|👇|🔗|Read more:)/);
        if (parts.length > 1) {
          description = parts[0].trim();
        } else {
          description = description.split(/\n\n.*utm_source=reel/)[0].trim();
        }
      }
      
      if (reel.wp_post_url) {
        const slugify = (text: string) => {
          if (!text) return '';
          return text.toString().toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-').trim();
        };
        const pageData = await this.prisma.ztteam_pages.findUnique({
          where: { id: reel.page_id },
          include: { fb_account: true }
        });
        
        const utmMedium = slugify(pageData?.fb_account?.name || 'account');
        const utmCampaign = slugify(pageData?.name || 'page');
        trackingLinkManual = `${reel.wp_post_url}${reel.wp_post_url.includes('?') ? '&' : '?'}utm_source=reel&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}`;
        
        if (pageData?.add_link_to_caption) {
          const prefixes = [
            '👉 Discover more here:',
            '🔥 Read the full story:',
            '📌 Check out the details:',
            '👇 Full article link:',
            '🔗 Learn more at:'
          ];
          const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
          description = `${prefix} ${trackingLinkManual}\n\n${description}`;
        }
      }

      if (!reel.page) {
        throw new Error('Video Reel chưa được gán cho Fanpage nào');
      }

      /** Kiểm tra an toàn: Không cho phép đăng trùng lặp nếu bài này đã được xuất bản ở Fanpage khác */
      const postTitleTrimmed = (reel.wp_post_title || '').trim();
      const alreadyPostedOtherPage = await this.prisma.ztteam_reels.findFirst({
        where: {
          id: { not: reel.id },
          is_posted: true,
          OR: [
            { wp_post_id: reel.wp_post_id },
            ...(postTitleTrimmed ? [{ wp_post_title: postTitleTrimmed }] : [])
          ]
        },
        include: { page: true }
      });

      if (alreadyPostedOtherPage) {
        return {
          error: `Reel này đã được xuất bản trên Fanpage "${alreadyPostedOtherPage.page?.name || alreadyPostedOtherPage.page_id}". Hệ thống chặn đăng trùng lặp để bảo vệ trang!`,
          code: 'ALREADY_POSTED_ELSEWHERE'
        };
      }

      const response = await this.facebookService.ztteam_publishReel(
        reel.page.fb_page_id,
        videoPath,
        description
      );

      /** ZTTeam: Ngay khi dang Reel thanh cong, gan link vao comment luon theo chuan tin tuc */
      if (response.id && (trackingLinkManual || reel.wp_post_url)) {
        try {
          const commentText = ztteam_getNewsComment(trackingLinkManual || reel.wp_post_url);
          if (commentText) {
            await this.facebookService.ztteam_publishComment(
              reel.page.fb_page_id,
              response.id,
              commentText
            );
          }
        } catch (e: any) {
          /** Ignore comment error so it doesn't fail the post status */
          console.error('Failed to post comment', e.message);
        }
      }

      await this.prisma.ztteam_reels.update({
        where: { id: reel.id },
        data: { 
          status: 'POSTED',
          is_posted: true,
          posted_at: new Date(),
          fb_post_id: response.id
        }
      });
      
      this.eventEmitter.emit('reel.updated', { id: reel.id, status: 'POSTED', fb_post_id: response.id });

      return { message: 'Đã đăng thành công', facebookResponse: response };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  /**
   * Scan storage directory on VPS and restore any missing reel video records to DB.
   * Also auto-assign custom templates to pages. On-demand safe endpoint for a specific VPS.
   */
  @Post('scan-storage')
  async ztteam_scanStorage() {
    const reelsDir = ztteam_getReelsPath();
    const pages = await this.prisma.ztteam_pages.findMany();
    if (pages.length === 0) {
      return { error: 'Chưa có Fanpage nào trong database' };
    }

    const defaultPage = pages[0];
    const defaultTemplate = await this.prisma.ztteam_templates.findFirst({ where: { format: 'video' } });
    const fallbackTemplateId = defaultTemplate?.id || 'cmsc3wj1a0004ekw74lkhss3n';

    /** 1. Check template fallback */

    /** 2. Auto-assign page custom templates if available */
    let templateAssignedCount = 0;
    for (const p of pages) {
      const customTemplate = await this.prisma.ztteam_templates.findFirst({
        where: {
          OR: [
            { fb_page_id: p.id },
            { fb_page_id: p.fb_page_id },
          ],
          format: 'video',
        },
      });
      if (customTemplate) {
        await this.prisma.ztteam_templates.update({
          where: { id: customTemplate.id },
          data: { fb_page_id: p.id },
        });
        if (!p.default_reel_template_id) {
          await this.prisma.ztteam_pages.update({
            where: { id: p.id },
            data: { default_reel_template_id: customTemplate.id },
          });
        }
        templateAssignedCount++;
      }
    }

    /** 3. Scan physical folders in storage/reels & restore valid ones with meta.json */
    let restoredCount = 0;

    if (fs.existsSync(reelsDir)) {
      const entries = fs.readdirSync(reelsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const reelId = entry.name;
        const reelWorkDir = path.join(reelsDir, reelId);
        const mp4Path = path.join(reelWorkDir, 'output.mp4');

        if (!fs.existsSync(mp4Path)) continue;

        const metaPath = path.join(reelWorkDir, 'meta.json');
        let meta: any = null;
        if (fs.existsSync(metaPath)) {
          try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
        }

        const existing = await this.prisma.ztteam_reels.findUnique({
          where: { id: reelId },
        });

        if (!existing && meta?.wpPostTitle) {
          const pageObj = pages.find(p => p.id === meta.pageId) || defaultPage;
          await this.prisma.ztteam_reels.create({
            data: {
              id: reelId,
              page_id: pageObj.id,
              wp_post_id: meta.wpPostId || 'restored',
              wp_post_title: meta.wpPostTitle,
              wp_post_url: meta.wpPostUrl,
              template_id: pageObj.default_reel_template_id || meta.templateId || fallbackTemplateId,
              video_url: `/storage/reels/${reelId}/output.mp4`,
              thumbnail_url: `/storage/reels/${reelId}/thumbnail.jpg`,
              audio_url: `/storage/reels/${reelId}/voice.mp3`,
              ai_script: meta.aiScript,
              ai_caption: meta.aiCaption,
              ai_hook: meta.aiHook,
              status: 'COMPLETED',
              is_posted: false,
              progress: 100,
            },
          });
          restoredCount++;
        }
      }
    }

    return {
      message: `Đã dọn dẹp nhãn tạm, phục hồi ${restoredCount} video Reels chuẩn và gán ${templateAssignedCount} template custom cho Fanpage`,
      restoredCount,
      templateAssignedCount,
    };
  }
}




