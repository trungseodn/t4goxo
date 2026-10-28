import { Controller, Get, Post, Put, Param, Body, Query, UseGuards, Sse, MessageEvent, Header, Delete, Request, UseInterceptors, UploadedFile, BadRequestException, Logger, Inject, forwardRef } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
/** @ts-ignore */
import { diskStorage } from 'multer';
import { ZTTeamAuthGuard } from '../auth/auth.guard';
import { ZTTeamImageProcessor } from './image.processor';
import { PrismaService } from '../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent } from 'rxjs';
import { map } from 'rxjs/operators';
import { ZTTeamFacebookService } from '../facebook/facebook.service';
import * as fs from 'fs';
import * as path from 'path';
import { ztteam_getImagesPath, ztteam_getStorageRoot, ztteam_getVideosPath } from '../common/ztteam_storage.util';
import { ZTTeamFetcherService } from '../crawler/fetcher.service';
import { ZTTeamAIService } from '../ai/ai.service';
import { ZTTeamStoryTestService } from '../story-test/story-test.service';
import { ZTTeamHookVideoService } from '../media/hook-video.service';
import { ztteam_getNewsComment } from '../common/ztteam_news_comment.util';

@Controller('image')
export class ZTTeamImageController {
  private readonly logger = new Logger(ZTTeamImageController.name);

  constructor(
    private readonly imageProcessor: ZTTeamImageProcessor,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly facebookService: ZTTeamFacebookService,
    private readonly fetcherService: ZTTeamFetcherService,
    private readonly aiService: ZTTeamAIService,
    private readonly hookVideoService: ZTTeamHookVideoService,
    @Inject(forwardRef(() => ZTTeamStoryTestService))
    private readonly storyTestService: ZTTeamStoryTestService,
  ) {}

  @Sse('events')
  @Header('Cache-Control', 'no-cache')
  @Header('X-Accel-Buffering', 'no')
  ztteam_imageEvents(): Observable<MessageEvent> {
    return fromEvent(this.eventEmitter, 'image.updated').pipe(
      map((payload) => {
        return { data: payload } as MessageEvent;
      }),
    );
  }

  @Post('create')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_createImageJob(
    @Body() body: { pageId: string; wpPostId: string; wpPostTitle: string; wpPostUrl?: string; templateId: string },
  ) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: {
        OR: [
          { fb_page_id: body.pageId },
          { id: body.pageId }
        ]
      }
    });

    if (!page) {
      throw new BadRequestException(`Không tìm thấy Fanpage ${body.pageId} trong hệ thống`);
    }

    /** Kiểm tra toàn cục tuyệt đối: Bài viết không được trùng lặp trên bất kỳ Fanpage nào */
    const wpIdStr = body.wpPostId.toString();
    const titleTrimmed = (body.wpPostTitle || '').trim();

    const existingInImages = await this.prisma.ztteam_images.findFirst({
      where: {
        OR: [
          { wp_post_id: wpIdStr },
          ...(titleTrimmed ? [{ wp_post_title: titleTrimmed }] : []),
          ...(body.wpPostUrl ? [{ wp_post_url: body.wpPostUrl }] : [])
        ]
      },
      include: { page: true }
    });
    if (existingInImages) {
      throw new BadRequestException(
        `Bài viết #${body.wpPostId} này đã tồn tại trong hàng đợi bài viết (thuộc Page "${existingInImages.page?.name || existingInImages.page_id || 'Kho thủ công'}"). Tuyệt đối không thể tạo trùng lặp.`
      );
    }

    const existingInHistory = await this.prisma.ztteam_image_history.findFirst({
      where: { wp_post_id: wpIdStr },
      include: { page: true }
    });
    if (existingInHistory) {
      throw new BadRequestException(
        `Bài viết #${body.wpPostId} này đã từng được sử dụng cho Page "${existingInHistory.page?.name || existingInHistory.page_id}". Tuyệt đối không thể tạo trùng lặp.`
      );
    }

    const existingInReels = await this.prisma.ztteam_reels.findFirst({
      where: {
        OR: [
          { wp_post_id: wpIdStr },
          ...(titleTrimmed ? [{ wp_post_title: titleTrimmed }] : []),
          ...(body.wpPostUrl ? [{ wp_post_url: body.wpPostUrl }] : [])
        ]
      },
      include: { page: true }
    });
    if (existingInReels) {
      throw new BadRequestException(
        `Bài viết #${body.wpPostId} này đã tồn tại trong hàng đợi Reel (thuộc Page "${existingInReels.page?.name || existingInReels.page_id}"). Tuyệt đối không thể tạo trùng lặp.`
      );
    }

    const existingInReelHistory = await this.prisma.ztteam_reel_history.findFirst({
      where: { wp_post_id: wpIdStr },
      include: { page: true }
    });
    if (existingInReelHistory) {
      throw new BadRequestException(
        `Bài viết #${body.wpPostId} này đã từng được tạo Reel cho Page "${existingInReelHistory.page?.name || existingInReelHistory.page_id}". Tuyệt đối không thể tạo trùng lặp.`
      );
    }

    const image = await this.prisma.ztteam_images.create({
      data: {
        page_id: page.id,
        wp_post_id: body.wpPostId,
        wp_post_title: body.wpPostTitle,
        wp_post_url: body.wpPostUrl,
        template_id: body.templateId,
      },
    });

    await this.prisma.ztteam_image_history.upsert({
      where: { page_id_wp_post_id: { page_id: page.id, wp_post_id: body.wpPostId } },
      create: { page_id: page.id, wp_post_id: body.wpPostId },
      update: {},
    });

    const jobId = await this.imageProcessor.ztteam_addJob({
      imageId: image.id,
      pageId: page.id,
      wpPostId: body.wpPostId,
      templateId: body.templateId,
    });

    return { success: true, imageId: image.id, jobId };
  }

  @Post('test-render')
  async ztteam_testRender(@Body() body: { templateId: string, title: string, images: string[] }) {
    const url = await this.imageProcessor.ztteam_testRender(body.templateId, body.title, body.images);
    return { success: true, url };
  }

  @Get('list')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_listImages(
    @Request() req: any,
    @Query('fbPageId') fbPageId?: string,
    @Query('status') status?: string,
    @Query('videoStatus') videoStatus?: string,
    @Query('search') search?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '24',
  ) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 24);
    const skip = (pageNum - 1) * limitNum;

    /** Base where theo User sở hữu Fanpage HOẶC bài đăng thủ công độc lập (page_id = null) */
    let baseWhere: any;
    if (fbPageId === 'MANUAL' || fbPageId === 'manual') {
      baseWhere = { page_id: null };
    } else if (fbPageId) {
      const p = await this.prisma.ztteam_pages.findFirst({
        where: {
          OR: [
            { fb_page_id: fbPageId },
            { id: fbPageId },
          ],
        },
      });
      if (!p) {
        return {
          data: [],
          total: 0,
          counts: { total: 0, queued: 0, rendering: 0, completed: 0, posted: 0, failed: 0, videoFailed: 0 },
        };
      }
      baseWhere = { page_id: p.id };
    } else {
      baseWhere = {
        OR: [
          {
            page: {
              fb_account: {
                owner_user_id: req.user.sub,
              },
            },
          },
          {
            page_id: null,
          },
        ],
      };
    }

    /** Điều kiện where cho danh sách hiển thị */
    const where: any = { ...baseWhere };

    /** Lọc từ khóa tìm kiếm (Tiêu đề, URL hoặc Caption) */
    if (search && search.trim()) {
      const kw = search.trim();
      where.OR = [
        { wp_post_title: { contains: kw, mode: 'insensitive' } },
        { wp_post_url: { contains: kw, mode: 'insensitive' } },
        { ai_caption: { contains: kw, mode: 'insensitive' } },
      ];
    }

    /** ZTTeam: Lọc trạng thái bài viết hoặc lỗi video render */
    if (status) {
      const s = status.toUpperCase();
      if (s === 'VIDEO_FAILED') {
        where.video_status = 'FAILED';
        where.is_posted = false;
      } else if (s === 'VIDEO_FAILED_POSTED') {
        where.video_status = 'FAILED';
        where.is_posted = true;
      } else if (s === 'POSTED') {
        const postedCondition = [{ is_posted: true }, { status: 'POSTED' }];
        if (where.OR) {
          where.AND = [{ OR: where.OR }, { OR: postedCondition }];
          delete where.OR;
        } else {
          where.OR = postedCondition;
        }
      } else if (s === 'COMPLETED') {
        where.status = 'COMPLETED';
        where.is_posted = false;
      } else if (s === 'QUEUED') {
        where.status = 'QUEUED';
        where.is_posted = false;
      } else if (s === 'RENDERING' || s === 'PROCESSING') {
        where.status = { in: ['RENDERING', 'PROCESSING'] };
        where.is_posted = false;
      } else if (s === 'FAILED') {
        where.status = 'FAILED';
      }
    }

    /** ZTTeam: Lọc theo trạng thái video render riêng biệt (nếu có) */
    if (videoStatus) {
      const vs = videoStatus.toUpperCase();
      if (vs === 'FAILED') {
        where.video_status = 'FAILED';
      } else if (vs === 'PENDING') {
        where.video_status = 'PENDING';
      } else if (vs === 'COMPLETED') {
        where.video_status = 'COMPLETED';
      } else if (vs === 'NONE') {
        where.video_status = { in: ['NONE', null] };
      }
    }

    /** Đếm song song số lượng bài theo từng trạng thái để hiển thị Tabs */
    const [
      images,
      total,
      countAll,
      countQueued,
      countRendering,
      countCompleted,
      countPosted,
      countFailed,
      countVideoFailed,
      countVideoFailedPosted,
      countManual,
    ] = await Promise.all([
      this.prisma.ztteam_images.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limitNum,
        include: { page: true },
      }),
      this.prisma.ztteam_images.count({ where }),
      this.prisma.ztteam_images.count({ where: baseWhere }),
      this.prisma.ztteam_images.count({
        where: { ...baseWhere, status: 'QUEUED', is_posted: false },
      }),
      this.prisma.ztteam_images.count({
        where: { ...baseWhere, status: { in: ['RENDERING', 'PROCESSING'] }, is_posted: false },
      }),
      this.prisma.ztteam_images.count({
        where: { ...baseWhere, status: 'COMPLETED', is_posted: false },
      }),
      this.prisma.ztteam_images.count({
        where: { ...baseWhere, OR: [{ is_posted: true }, { status: 'POSTED' }] },
      }),
      this.prisma.ztteam_images.count({
        where: { ...baseWhere, status: 'FAILED' },
      }),
      this.prisma.ztteam_images.count({
        where: { ...baseWhere, video_status: 'FAILED', is_posted: false },
      }),
      this.prisma.ztteam_images.count({
        where: { ...baseWhere, video_status: 'FAILED', is_posted: true },
      }),
      this.prisma.ztteam_images.count({
        where: { page_id: null },
      }),
    ]);

    const pageIds = [...new Set(images.map(r => r.page_id).filter((id): id is string => Boolean(id)))];
    const lastPostedImages = await this.prisma.ztteam_images.findMany({
      where: { page_id: { in: pageIds }, is_posted: true },
      orderBy: { posted_at: 'desc' },
      distinct: ['page_id']
    });
    const lastPostedReels = await this.prisma.ztteam_reels.findMany({
      where: { page_id: { in: pageIds }, status: 'POSTED' },
      orderBy: { updated_at: 'desc' },
      distinct: ['page_id']
    });

    const lastPostedMap = new Map<string, Date>();
    for (const img of lastPostedImages) {
      if (img.page_id && img.posted_at) lastPostedMap.set(img.page_id, img.posted_at);
    }
    for (const r of lastPostedReels) {
      const existing = lastPostedMap.get(r.page_id);
      if (!existing || r.updated_at > existing) {
        lastPostedMap.set(r.page_id, r.updated_at);
      }
    }
    
    /** Simulate queue to get precise scheduled times for all pending images */
    const allPending = await this.prisma.ztteam_images.findMany({
       where: { status: { in: ['QUEUED', 'RENDERING', 'COMPLETED'] }, is_posted: false },
       orderBy: { created_at: 'asc' },
       include: { page: true }
    });
    
    const pageNextTimeMap = new Map<string, Date | null>();
    const imageScheduledTimeMap = new Map<string, Date | null>();
    const ztteam_now = new Date();

    for (const pending of allPending) {
       const pageId = pending.page_id;
       const p = pending.page as any;
       if (!pageId || !p) continue;

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

       imageScheduledTimeMap.set(pending.id, scheduledAt);
       if (scheduledAt) {
         pageNextTimeMap.set(pageId, scheduledAt);
       }
    }

    const imagesWithDetails = images.map(r => {
      let posted_at = null;
      let scheduled_at = null;

      if (r.is_posted) {
        posted_at = r.posted_at || r.updated_at;
      } else {
        scheduled_at = imageScheduledTimeMap.get(r.id) || null;
      }

      return {
        ...r,
        posted_at,
        scheduled_at
      };
    });

    return {
      data: imagesWithDetails,
      total,
      counts: {
        total: countAll,
        queued: countQueued,
        rendering: countRendering,
        completed: countCompleted,
        posted: countPosted,
        failed: countFailed,
        videoFailed: countVideoFailed,
        videoFailedPosted: countVideoFailedPosted,
        manual: countManual,
      },
    };
  }

  /**
   * ZTTeam: Đưa hàng loạt bài viết lỗi video Reel về hàng chờ tạo video
   * POST /api/image/retry-failed-videos
   */
  /**
   * ZTTeam: Tự động quét và dọn dẹp các bài viết trùng lặp đang nằm trong hàng đợi (chưa đăng)
   * POST /api/image/cleanup-duplicates
   */
  @Post('cleanup-duplicates')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_cleanupDuplicates() {
    let removedCount = 0;
    const details: any[] = [];

    // 1. Quét trùng lặp theo wp_post_id trong ztteam_images
    const duplicatesById = await this.prisma.$queryRaw<Array<{ wp_post_id: string; cnt: number }>>`
      SELECT wp_post_id, COUNT(*)::int as cnt
      FROM ztteam_images
      WHERE wp_post_id IS NOT NULL AND wp_post_id != ''
      GROUP BY wp_post_id
      HAVING COUNT(*) > 1
    `;

    for (const dup of duplicatesById) {
      const allCopies = await this.prisma.ztteam_images.findMany({
        where: { wp_post_id: dup.wp_post_id },
        include: { page: true },
        orderBy: [
          { is_posted: 'desc' },
          { created_at: 'asc' }
        ]
      });

      const [primary, ...toRemove] = allCopies;

      for (const item of toRemove) {
        if (!item.is_posted) {
          await this.prisma.ztteam_images.delete({ where: { id: item.id } });
          removedCount++;
          details.push({
            type: 'image_by_id',
            wpPostId: dup.wp_post_id,
            removedId: item.id,
            title: item.wp_post_title,
            removedFromPage: item.page?.name || item.page_id || 'Kho thủ công',
            keptOnPage: primary.page?.name || primary.page_id || 'Kho thủ công'
          });
        }
      }
    }

    // 2. Quét trùng lặp theo Tiêu đề (wp_post_title) trong ztteam_images
    const duplicatesByTitle = await this.prisma.$queryRaw<Array<{ clean_title: string; cnt: number }>>`
      SELECT LOWER(TRIM(wp_post_title)) as clean_title, COUNT(*)::int as cnt
      FROM ztteam_images
      WHERE wp_post_title IS NOT NULL AND wp_post_title != ''
      GROUP BY LOWER(TRIM(wp_post_title))
      HAVING COUNT(*) > 1
    `;

    for (const dup of duplicatesByTitle) {
      const allCopies = await this.prisma.ztteam_images.findMany({
        where: {
          wp_post_title: {
            mode: 'insensitive',
            equals: dup.clean_title
          }
        },
        include: { page: true },
        orderBy: [
          { is_posted: 'desc' },
          { created_at: 'asc' }
        ]
      });

      if (allCopies.length > 1) {
        const [primary, ...toRemove] = allCopies;
        for (const item of toRemove) {
          if (!item.is_posted) {
            await this.prisma.ztteam_images.delete({ where: { id: item.id } });
            removedCount++;
            details.push({
              type: 'image_by_title',
              wpPostId: item.wp_post_id,
              removedId: item.id,
              title: item.wp_post_title,
              removedFromPage: item.page?.name || item.page_id || 'Kho thủ công',
              keptOnPage: primary.page?.name || primary.page_id || 'Kho thủ công'
            });
          }
        }
      }
    }

    // 3. Quét trùng lặp theo wp_post_id trong ztteam_reels
    const duplicateReels = await this.prisma.$queryRaw<Array<{ wp_post_id: string; cnt: number }>>`
      SELECT wp_post_id, COUNT(*)::int as cnt
      FROM ztteam_reels
      WHERE wp_post_id IS NOT NULL AND wp_post_id != ''
      GROUP BY wp_post_id
      HAVING COUNT(*) > 1
    `;

    for (const dup of duplicateReels) {
      const allCopies = await this.prisma.ztteam_reels.findMany({
        where: { wp_post_id: dup.wp_post_id },
        include: { page: true },
        orderBy: [
          { is_posted: 'desc' },
          { created_at: 'asc' }
        ]
      });

      const [primary, ...toRemove] = allCopies;

      for (const item of toRemove) {
        if (!item.is_posted) {
          await this.prisma.ztteam_reels.delete({ where: { id: item.id } });
          removedCount++;
          details.push({
            type: 'reel_by_id',
            wpPostId: dup.wp_post_id,
            removedId: item.id,
            title: item.wp_post_title,
            removedFromPage: item.page?.name || item.page_id,
            keptOnPage: primary.page?.name || primary.page_id
          });
        }
      }
    }

    // 4. Quét trùng chéo giữa Images và Reels (Nếu Image đã có thì xóa Reel chưa đăng)
    const crossDuplicates = await this.prisma.$queryRaw<Array<{ wp_post_id: string }>>`
      SELECT DISTINCT img.wp_post_id
      FROM ztteam_images img
      JOIN ztteam_reels reel ON img.wp_post_id = reel.wp_post_id
      WHERE reel.is_posted = false
    `;

    for (const cd of crossDuplicates) {
      const reelsToDelete = await this.prisma.ztteam_reels.findMany({
        where: { wp_post_id: cd.wp_post_id, is_posted: false },
        include: { page: true }
      });
      for (const r of reelsToDelete) {
        await this.prisma.ztteam_reels.delete({ where: { id: r.id } });
        removedCount++;
        details.push({
          type: 'cross_reel_removed',
          wpPostId: cd.wp_post_id,
          removedId: r.id,
          title: r.wp_post_title,
          removedFromPage: r.page?.name || r.page_id,
          keptOnPage: 'ztteam_images'
        });
      }
    }

    return {
      success: true,
      duplicateWpPostsCount: duplicatesById.length + duplicatesByTitle.length + duplicateReels.length,
      removedUnpostedDuplicatesCount: removedCount,
      details: details.slice(0, 100),
    };
  }

  @Post('retry-failed-videos')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_retryFailedVideos(@Body() body: { scope?: string; pageId?: string }) {
    const scope = body?.scope || 'unposted'; // 'unposted' | 'posted' | 'all'
    const where: any = { video_status: 'FAILED' };

    if (scope === 'unposted') {
      where.is_posted = false;
    } else if (scope === 'posted') {
      where.is_posted = true;
    }

    if (body?.pageId) {
      where.page_id = body.pageId;
    }

    const updateRes = await this.prisma.ztteam_images.updateMany({
      where,
      data: {
        video_status: 'PENDING',
        error_log: null,
        updated_at: new Date(),
      },
    });

    this.logger.log(`[Batch Retry Videos] Reset ${updateRes.count} failed video posts to PENDING (scope: ${scope})`);

    return {
      success: true,
      message: `Đã đưa ${updateRes.count} bài viết lỗi về hàng chờ tạo video thành công`,
      count: updateRes.count,
    };
  }

  @Post(':id/post-to-fb')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_postToFb(@Param('id') id: string) {
    const image = await this.prisma.ztteam_images.findUnique({
      where: { id },
      include: { page: true }
    });
    if (!image) throw new Error('Image not found');

    if (!image.image_url) throw new Error('Image output not available');

    let absoluteImagePath = ztteam_getImagesPath(image.id, 'output.png');

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
      throw new Error('Image file not found on disk');
    }

    if (!image.page || !image.page.fb_page_id || !image.page_id) {
      throw new BadRequestException('Bài viết này không thuộc Fanpage Facebook nào để đăng tự động. Vui lòng đăng thủ công.');
    }

    /** Kiểm tra an toàn: Không cho phép đăng trùng nếu bài này đã được xuất bản ở Fanpage khác */
    const imageTitleTrimmed = (image.wp_post_title || '').trim();
    const alreadyPostedOtherPage = await this.prisma.ztteam_images.findFirst({
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

    if (alreadyPostedOtherPage) {
      throw new BadRequestException(
        `Bài viết này đã được đăng trên Fanpage "${alreadyPostedOtherPage.page?.name || alreadyPostedOtherPage.page_id}". Hệ thống chặn để tuyệt đối không đăng trùng lặp giữa các trang!`
      );
    }

    const targetFbPageId = image.page.fb_page_id;
    let description = image.ai_caption || image.wp_post_title || '';
    let trackingLinkManual = '';
    
    if (image.wp_post_url) {
      const slugify = (text: string) => {
        if (!text) return '';
        return text.toString().toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-').trim();
      };
      const pageData = await this.prisma.ztteam_pages.findUnique({
        where: { id: image.page_id },
        include: { fb_account: true }
      }) as any;
      const utmMedium = slugify(pageData?.fb_account?.name || 'account');
      const utmCampaign = slugify(pageData?.name || 'page');
      trackingLinkManual = `${image.wp_post_url}${image.wp_post_url.includes('?') ? '&' : '?'}utm_source=image&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}`;
      
      if (image.page?.add_link_to_caption) {
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

    let fbPostId: string;
    const pageFormat = image.page?.post_format || 'reel';

    /** ZTTeam: Tuân thủ tuyệt đối cấu hình Kiểu bài đăng chính trên Fanpage (post_format) */
    if (pageFormat === 'reel') {
      /** Cấu hình: Nếu chọn reel thì đăng reel, nếu bài chuẩn bị đăng ko có reel thì đăng ảnh (đảm bảo phải có bài để đăng) */
      if (image.video_url) {
        let absoluteVideoPath = '';
        if (image.video_url.startsWith('/storage/')) {
          absoluteVideoPath = path.join(ztteam_getStorageRoot(), image.video_url.replace(/^\/storage\//, ''));
        } else {
          absoluteVideoPath = path.join(ztteam_getStorageRoot(), image.video_url.replace(/^[/\\]+/, ''));
        }

        if (fs.existsSync(absoluteVideoPath)) {
          const response = await this.facebookService.ztteam_publishReel(
            targetFbPageId,
            absoluteVideoPath,
            description
          );
          fbPostId = response.id;
        } else {
          /** Nếu file video không tìm thấy trên server -> fallback đăng Ảnh */
          fbPostId = await this.facebookService.ztteam_publishPhoto(
            targetFbPageId,
            absoluteImagePath,
            description
          );
        }
      } else {
        /** Bài chưa tạo video Reel -> Fallback đăng Ảnh để đảm bảo luôn có bài xuất bản */
        fbPostId = await this.facebookService.ztteam_publishPhoto(
          targetFbPageId,
          absoluteImagePath,
          description
        );
      }
    } else if (pageFormat === 'image') {
      /** Cấu hình: Nếu chọn ảnh thì chắc chắn phải đăng ảnh */
      fbPostId = await this.facebookService.ztteam_publishPhoto(
        targetFbPageId,
        absoluteImagePath,
        description
      );
    } else {
      /** Cấu hình: Xen kẽ (Mixed) - Trường hợp bài có video thì đăng Reel, ko có video thì vẫn đăng Ảnh */
      if (image.video_url) {
        let absoluteVideoPath = '';
        if (image.video_url.startsWith('/storage/')) {
          absoluteVideoPath = path.join(ztteam_getStorageRoot(), image.video_url.replace(/^\/storage\//, ''));
        } else {
          absoluteVideoPath = path.join(ztteam_getStorageRoot(), image.video_url.replace(/^[/\\]+/, ''));
        }

        if (fs.existsSync(absoluteVideoPath)) {
          const response = await this.facebookService.ztteam_publishReel(
            targetFbPageId,
            absoluteVideoPath,
            description
          );
          fbPostId = response.id;
        } else {
          fbPostId = await this.facebookService.ztteam_publishPhoto(
            targetFbPageId,
            absoluteImagePath,
            description
          );
        }
      } else {
        fbPostId = await this.facebookService.ztteam_publishPhoto(
          targetFbPageId,
          absoluteImagePath,
          description
        );
      }
    }

    /** ZTTeam: Ngay khi dang thanh cong, gan link vao comment luon theo chuan tin tuc */
    let hookCommentId: string | null = null;
    if (fbPostId && (image.wp_post_url || image.ai_first_comment)) {
      try {
        const newsComment = ztteam_getNewsComment(image.wp_post_url, image.ai_first_comment);
        if (newsComment) {
          const commentRes = await this.facebookService.ztteam_publishComment(
            targetFbPageId,
            fbPostId,
            newsComment
          );
          hookCommentId = typeof commentRes === 'object' && commentRes?.id
            ? String(commentRes.id)
            : (typeof commentRes === 'string' ? commentRes : null);
        }
      } catch (cmtErr: any) {
        this.logger.error(`Failed to post instant comment for image ${id}: ${cmtErr.message}`);
      }
    }

    const updatedImage = await this.prisma.ztteam_images.update({
      where: { id },
      data: {
        is_posted: true,
        posted_at: new Date(),
        fb_post_id: fbPostId,
        status: 'POSTED',
        comment_step: hookCommentId ? 2 : 0,
        hook_comment_id: hookCommentId,
        hook_comment_at: hookCommentId ? new Date() : null,
      }
    });

    this.eventEmitter.emit('image.updated', updatedImage);

    return { success: true, fbPostId };
  }

  @Post(':id/test-render-queue')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_testRenderQueue(@Param('id') id: string) {
    try {
      const imageUrl = await this.imageProcessor.ztteam_testRenderQueueItem(id);
      return { success: true, imageUrl };
    } catch (error: any) {
      throw new Error(error.message || 'Lỗi tạo ảnh test');
    }
  }

  @Put(':id/save-caption')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_saveImageCaption(
    @Param('id') id: string,
    @Body() body: { caption?: string; firstComment?: string }
  ) {
    const updated = await this.prisma.ztteam_images.update({
      where: { id },
      data: {
        ai_caption: body.caption,
        ai_first_comment: body.firstComment
      }
    });
    this.eventEmitter.emit('image.updated', updated);
    return { success: true };
  }

  /**
   * ZTTeam: Tạo lại Caption & First Comment theo chuẩn True-Crime Cold Case mới
   * POST /api/image/:id/regenerate-cold-case
   */
  @Post(':id/regenerate-cold-case')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_regenerateColdCaseContent(@Param('id') id: string) {
    const post = await this.prisma.ztteam_images.findUnique({
      where: { id },
      include: { page: true },
    });
    if (!post) {
      throw new Error(`Không tìm thấy bài viết ${id}`);
    }

    const rawStory = post.ai_caption || post.wp_post_title || '';
    const postUrl = post.wp_post_url || '';
    const customPrompt = (post.page as any)?.ai_custom_prompt || null;

    const coldCaseData = await this.aiService.ztteam_generateColdCaseContent(
      post.wp_post_title || 'Cold Case',
      rawStory,
      customPrompt,
      postUrl
    );

    const updated = await this.prisma.ztteam_images.update({
      where: { id },
      data: {
        ai_caption: coldCaseData.fullCaption,
        ai_first_comment: coldCaseData.commentText,
      },
    });

    this.eventEmitter.emit('image.updated', updated);

    return {
      success: true,
      caption: coldCaseData.fullCaption,
      firstComment: coldCaseData.commentText,
      coldCaseData,
    };
  }

  /**
   * ZTTeam: Thử lại bài viết ảnh
   * - Nếu đã có file ảnh (image_url) và không có cờ force: Chỉ làm mới khung giờ xuất bản (status = COMPLETED), giữ nguyên ảnh, không gọi SangTao.ai vẽ lại.
   * - Nếu chưa có file ảnh hoặc truyền ?force=true: Vẽ lại ảnh mới bằng AI.
   */
  @Post('retry/:id')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_retryImage(@Param('id') id: string, @Query('force') force?: string) {
    const image = await this.prisma.ztteam_images.findUnique({ where: { id } });
    if (!image) throw new Error('Image not found');

    const shouldForceRecreate = force === 'true' || force === '1';

    /** Kiểm tra xem ảnh đã có sẵn file ảnh hợp lệ trên đĩa hay chưa */
    let hasExistingImageFile = false;
    if (image.image_url) {
      const absoluteImagePath = ztteam_getImagesPath(image.id, 'output.png');
      if (fs.existsSync(absoluteImagePath)) {
        hasExistingImageFile = true;
      } else {
        let fallback = '';
        if (image.image_url.startsWith('/storage') || image.image_url.startsWith('storage')) {
          fallback = path.join(ztteam_getStorageRoot(), image.image_url.replace(/^\/?storage[/\\]?/, ''));
        } else if (fs.existsSync(image.image_url)) {
          fallback = image.image_url;
        } else {
          fallback = path.join(ztteam_getStorageRoot(), image.image_url.replace(/^[/\\]+/, ''));
        }
        if (fallback && fs.existsSync(fallback)) {
          hasExistingImageFile = true;
        }
      }
    }

    /** Nếu đã có file ảnh và không ép buộc tạo lại ảnh: CHỈ LÀM MỚI KHUNG GIỜ VÀ ĐẶT LẠI TRẠNG THÁI COMPLETED */
    if (hasExistingImageFile && !shouldForceRecreate) {
      const updated = await this.prisma.ztteam_images.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          error_log: null,
          post_retry_count: 0,
        }
      });
      this.eventEmitter.emit('image.updated', updated);
      return {
        success: true,
        message: 'Đã làm mới lại khung giờ xuất bản (giữ nguyên ảnh)',
        mode: 'rescheduled',
        image: updated,
      };
    }

    /** Nếu chưa có ảnh hoặc yêu cầu ép vẽ lại ảnh mới: Mới đẩy vào worker AI */
    const updated = await this.prisma.ztteam_images.update({
      where: { id },
      data: { status: 'QUEUED', error_log: null, post_retry_count: 0 }
    });
    this.eventEmitter.emit('image.updated', updated);

    const jobId = await this.imageProcessor.ztteam_addJob({
      imageId: image.id,
      pageId: image.page_id || '',
      wpPostId: image.wp_post_id,
      templateId: image.template_id,
    });

    return {
      success: true,
      jobId,
      message: 'Đã thêm vào hàng đợi vẽ lại ảnh mới bằng AI',
      mode: 'regenerated',
    };
  }

  @Delete(':id')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_deleteImage(@Param('id') id: string) {
    const image = await this.prisma.ztteam_images.findUnique({ where: { id } });
    if (!image) return { success: true };

    const workDir = ztteam_getImagesPath(image.id);
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    await this.prisma.ztteam_images.delete({ where: { id } });
    return { success: true };
  }

  /**
   * ZTTeam: Lấy bài viết đang chờ tạo Video Reel cho Muse Worker
   * GET /api/image/pending-video
   */
  @Get('pending-video')
  async ztteam_getPendingVideo(@Query('auto') auto?: string) {
    /** 0. ZTTeam: Tự động giải phóng các job PROCESSING bị kẹt quá 15 phút do worker bị tắt */
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    await this.prisma.ztteam_images.updateMany({
      where: {
        video_status: 'PROCESSING',
        video_created_at: { lt: fifteenMinutesAgo },
      },
      data: {
        video_status: 'PENDING',
      },
    });

    let lockedId: string | null = null;

    /** ZTTeam: Sử dụng Transaction kết hợp FOR UPDATE SKIP LOCKED để khoá nguyên tử 1 job duy nhất, chống xung đột nhiều worker/luồng */
    await this.prisma.$transaction(async (tx) => {
      /** 1. Ưu tiên bài viết được đánh dấu PENDING (Kho Đăng Thủ Công hoặc Fanpage Reel/Mixed, chỉ lấy bài CHƯA đăng) */
      const lockedPendingRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT zi.id 
        FROM ztteam_images zi
        WHERE zi.status = 'COMPLETED'
          AND zi.is_posted = false
          AND zi.image_url IS NOT NULL
          AND zi.video_status = 'PENDING'
          AND (
            zi.page_id IS NULL 
            OR zi.page_id IN (
              SELECT zp.id FROM ztteam_pages zp WHERE zp.post_format IN ('reel', 'mixed')
            )
          )
        ORDER BY zi.updated_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);

      let chosenId = lockedPendingRows?.[0]?.id;

      /** 2. Nếu auto=true và không có bài PENDING: Tự động lấy các bài cũ của Fanpage Reel/Mixed hoặc Kho Thủ Công chưa có video */
      if (!chosenId && auto === 'true') {
        const lockedAutoRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
          SELECT zi.id 
          FROM ztteam_images zi
          WHERE zi.status = 'COMPLETED'
            AND zi.is_posted = false
            AND zi.image_url IS NOT NULL
            AND zi.video_url IS NULL
            AND zi.video_status IN ('NONE', 'FAILED')
            AND (
              zi.page_id IS NULL 
              OR zi.page_id IN (
                SELECT zp.id FROM ztteam_pages zp WHERE zp.post_format IN ('reel', 'mixed')
              )
            )
          ORDER BY zi.created_at DESC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `);
        chosenId = lockedAutoRows?.[0]?.id;
      }

      if (chosenId) {
        await tx.ztteam_images.update({
          where: { id: chosenId },
          data: {
            video_status: 'PROCESSING',
            video_created_at: new Date(),
          },
        });
        lockedId = chosenId;
      }
    });

    if (!lockedId) {
      return { success: true, hasJob: false };
    }

    const post = await this.prisma.ztteam_images.findUnique({
      where: { id: lockedId },
      include: { page: true },
    });

    if (!post) {
      return { success: true, hasJob: false };
    }

    /** ZTTeam: Lấy trực tiếp nội dung caption hoặc title làm kịch bản video nguyên bản */
    const rawText = post.ai_caption || post.wp_post_title || '';
    const storyContent = this.ztteam_sanitizePromptForMuse(rawText);

    /** Tạo câu lệnh chuẩn: Dựa vào hình ảnh đính kèm, và nội dung dưới đây, hãy tạo 1 video đúng với nội dung hiện tại */
    const prompt = `Dựa vào hình ảnh đính kèm, và nội dung dưới đây, hãy tạo 1 video đúng với nội dung hiện tại:\n\n${storyContent}`;

    return {
      success: true,
      hasJob: true,
      job: {
        id: post.id,
        wpPostId: post.wp_post_id,
        title: post.wp_post_title,
        imageUrl: post.image_url,
        caption: post.ai_caption,
        prompt,
      },
    };
  }

  /**
   * ZTTeam: Hàm làm sạch nội dung prompt cho Muse.ai né bộ lọc vi phạm chính sách
   */
  private ztteam_sanitizePromptForMuse(rawText: string): string {
    let text = (rawText || '').trim();

    /** 1. Loại bỏ các phần đuôi CTA */
    text = text.replace(/\.\.\.FULL STORY IN THE COMMENT.*$/is, '');
    text = text.replace(/\.\.\.FULL STORY.*$/is, '');
    text = text.replace(/👉\s*FULL STORY.*$/is, '');
    text = text.replace(/👉\s*Discover more here:.*$/is, '');
    text = text.replace(/PART ONE\s*—.*$/is, '');

    /** 2. Loại bỏ các dòng tiêu đề in hoa thừa ở đầu */
    const lines = text.split('\n');
    if (lines.length > 1 && lines[0].trim() === lines[0].trim().toUpperCase() && lines[0].trim().length > 15) {
      lines.shift();
      while (lines.length > 0 && lines[0].trim() === '') lines.shift();
      text = lines.join('\n');
    }

    /** 3. Bản đồ thay thế các từ ngữ nhạy cảm / bạo lực / ly hôn / ngoại tình sang từ ngữ điện ảnh trung lập */
    const sensitiveMap: [RegExp, string][] = [
      [/\bmafia(\s+boss)?\b/gi, 'powerful boss'],
      [/\bblood(y)?\b/gi, 'tension'],
      [/\bmurder(ed|er|ing)?\b/gi, 'incident'],
      [/\bkill(ed|er|ing)?\b/gi, 'conflict'],
      [/\bgun(shot|fire|s)?\b/gi, 'danger'],
      [/\bcrime(s)?\b/gi, 'mystery'],
      [/\bviolence\b/gi, 'intense action'],
      [/\bdead(ly)?\b/gi, 'urgent'],
      [/\bcorpse\b/gi, 'person'],
      [/\bsuicide\b/gi, 'crisis'],
      [/\bambulance\b/gi, 'rescue vehicle'],
      [/\bcrashed\b/gi, 'halted unexpectedly'],
      [/\bdispute\b/gi, 'negotiation'],
      [/\bweapon(s)?\b/gi, 'gadget'],
      [/\b(getting|get|got|are)?\s*divorce(d)?\b/gi, 'parting ways'],
      [/\bdivorce\b/gi, 'parting ways'],
      [/\bbackup(\s+\w+)?\b/gi, 'second choice'],
      [/\b(ex|former\s*partner)\b/gi, 'past acquaintance'],
      [/\baffair(s)?\b/gi, 'secret'],
      [/\bcheat(ed|ing|er|ers)?\b/gi, 'betrayal'],
      [/\bmistress(es)?\b/gi, 'rival'],
      [/\b(signs?|signed|asking\s+her\s+to\s+sign)\s+(a\s+)?(document|agreement|papers?)\b/gi, 'settles the final decision'],
      [/\b(document|agreement|papers?)\b/gi, 'decision'],
      [/\b(divorce\s+papers|divorce\s+agreement)\b/gi, 'written resolution'],
      [/\bdefamation\b/gi, 'dispute'],
      [/\bsue(d|ing)?\b/gi, 'confront'],
    ];

    for (const [regex, replacement] of sensitiveMap) {
      text = text.replace(regex, replacement);
    }

    /** 4. Chuẩn hóa độ dài câu chuyện: giữ trọn vẹn toàn bộ đoạn hook và diễn biến kịch tính (tối đa 800 ký tự) */
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 800) {
      const cutIndex = text.lastIndexOf('.', 800);
      if (cutIndex > 400) {
        text = text.substring(0, cutIndex + 1);
      }
    }

    return text;
  }

  /**
   * ZTTeam: Đưa bài viết vào hàng đợi tạo video Reel
   * POST /api/image/:id/queue-video
   */
  @Post(':id/queue-video')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_queueVideo(@Param('id') id: string) {
    const post = await this.prisma.ztteam_images.findUnique({
      where: { id },
      include: { page: true },
    });
    if (!post) {
      throw new Error(`Không tìm thấy bài viết ${id}`);
    }

    const engine = (post.page as any)?.video_engine || 'hook_image';

    if (engine === 'hook_image' || engine === 'text_story') {
      /** Kích hoạt render Video Hook sắc nét / Text Story 10s tự động ngay tại server (cho phép force đối với bài đã xuất bản ảnh) */
      this.hookVideoService.ztteam_renderHookVideo(id, { forceRegenHook: true }).catch(err => {
        this.logger.error(`[Manual Hook/Text Story Video Error] ${err.message}`);
      });

      return {
        success: true,
        message: engine === 'text_story'
          ? 'Đang tiến hành tạo Video Text Story 10s kịch tính từ bài viết...'
          : 'Đang tiến hành tạo Video Hook 10s sắc nét từ ảnh...',
        post: { ...post, video_status: 'PENDING' },
      };
    }

    /** Nếu là Muse: Đưa vào hàng đợi cho Worker ngoài */
    const updated = await this.prisma.ztteam_images.update({
      where: { id },
      data: { video_status: 'PENDING', error_log: null },
    });
    this.eventEmitter.emit('image.updated', updated);

    return {
      success: true,
      message: 'Đã đưa bài viết vào hàng đợi tạo Video Reel cho Worker',
      post: updated,
    };
  }

  /**
   * ZTTeam: Worker upload file video MP4 hoàn thành lên hệ thống
   * POST /api/image/:id/attach-video
   */
  @Post(':id/attach-video')
  @UseInterceptors(FileInterceptor('video', {
    storage: diskStorage({
      destination: (req: any, file: any, cb: any) => {
        const videosPath = ztteam_getVideosPath();
        if (!fs.existsSync(videosPath)) {
          fs.mkdirSync(videosPath, { recursive: true });
        }
        cb(null, videosPath);
      },
      filename: (req: any, file: any, cb: any) => {
        const timestamp = Date.now();
        const safeId = req.params.id || 'vid';
        cb(null, `muse_reel_${safeId}_${timestamp}.mp4`);
      },
    }),
  }))
  async ztteam_attachVideo(@Param('id') id: string, @UploadedFile() file: any) {
    if (!file) {
      throw new Error('Chưa có file video nào được tải lên');
    }

    const videoUrl = `/storage/videos/${file.filename}`;
    const updated = await this.prisma.ztteam_images.update({
      where: { id },
      data: {
        video_url: videoUrl,
        video_status: 'COMPLETED',
        video_engine: 'muse',
        video_created_at: new Date(),
      },
    });

    this.eventEmitter.emit('image.updated', updated);

    return {
      success: true,
      message: 'Đã gắn Video Reel vào bài viết thành công!',
      videoUrl,
      post: updated,
    };
  }

  /**
   * ZTTeam: Lấy ảnh gốc từ website làm chuẩn để tạo Video Reel khi tạo ảnh AI thất bại
   * POST /api/image/:id/use-original-image
   */
  @Post(':id/use-original-image')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_useOriginalImage(@Param('id') id: string) {
    const post = await this.prisma.ztteam_images.findUnique({
      where: { id },
      include: { page: true },
    });

    if (!post) {
      throw new Error(`Không tìm thấy bài viết ${id}`);
    }

    /** Chặn tuyệt đối: Nếu bài viết đã đăng lên Facebook thì không cho tạo video nữa */
    if (post.is_posted || post.status === 'POSTED') {
      throw new BadRequestException('Bài viết này đã được đăng lên Facebook, không thể tạo lại video nữa.');
    }

    const itemDir = path.join(ztteam_getImagesPath(), id);
    if (!fs.existsSync(itemDir)) {
      fs.mkdirSync(itemDir, { recursive: true });
    }
    const localFilePath = path.join(itemDir, 'original.png');
    const localOutputPath = path.join(itemDir, 'output.png');
    const localSourceOriginal = path.join(itemDir, 'source_original.png');

    /** 1. Kiểm tra nếu đã có file ảnh gốc dự phòng được lưu trước đó tại thư mục riêng */
    let hasSourceFile = false;
    if (fs.existsSync(localSourceOriginal)) {
      try {
        fs.copyFileSync(localSourceOriginal, localFilePath);
        fs.copyFileSync(localSourceOriginal, localOutputPath);
        hasSourceFile = true;
      } catch (e) {
        /** Tiếp tục fallback tải qua mạng */
      }
    }

    /** 2. Nếu chưa có file gốc trên ổ đĩa, xác định URL bài viết nguồn từ ztteam_crawl_history */
    let sourceImageUrl: string | null = null;

    if (!hasSourceFile) {
      let sourceUrl: string | null = null;

      if (post.wp_post_title) {
        const cleanTitle = post.wp_post_title.trim();
        const shortTitle = cleanTitle.substring(0, 35);
        const crawlHistory = await this.prisma.ztteam_crawl_history.findFirst({
          where: {
            OR: [
              { title: cleanTitle },
              { title: { contains: shortTitle, mode: 'insensitive' } },
            ],
          },
          orderBy: { created_at: 'desc' },
        });

        if (crawlHistory && crawlHistory.url && crawlHistory.url.startsWith('http')) {
          sourceUrl = crawlHistory.url;
        }
      }

      /** Nếu không tìm thấy trong crawl_history, kiểm tra wp_post_url có phải website ngoài không */
      if (!sourceUrl && post.wp_post_url) {
        const targetSites = await this.prisma.ztteam_target_sites.findMany({ select: { wp_url: true } });
        const isInternalSite = targetSites.some((s) => {
          try {
            return new URL(s.wp_url).hostname.toLowerCase() === new URL(post.wp_post_url!).hostname.toLowerCase();
          } catch (e) {
            return false;
          }
        });
        /** Chỉ dùng wp_post_url nếu nó KHÔNG phải website WordPress đích cá nhân */
        if (!isInternalSite) {
          sourceUrl = post.wp_post_url;
        }
      }

      /** 3. Bóc tách ảnh gốc từ link website nguồn bằng FetcherService */
      if (sourceUrl) {
        try {
          const storyData = await this.fetcherService.ztteam_fetchUrlData(sourceUrl);
          if (storyData && (storyData.image || (storyData.images && storyData.images.length > 0))) {
            sourceImageUrl = storyData.image || (storyData.images ? storyData.images[0] : null);
          }
        } catch (fetchErr: any) {
          /** Fallback regex thẻ meta nếu fetchUrlData gặp trở ngại */
          try {
            const res = await fetch(sourceUrl, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              },
              signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
              const html = await res.text();
              const match =
                html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
              if (match && match[1]) {
                sourceImageUrl = match[1];
              }
            }
          } catch (e) {
            /** Bỏ qua */
          }
        }
      }

      if (!sourceImageUrl) {
        throw new Error('Không thể tìm thấy link ảnh gốc của bài viết từ website nguồn');
      }

      /** 4. Tải ảnh gốc từ website nguồn về lưu trữ cục bộ */
      const axios = require('axios');
      const writer = fs.createWriteStream(localFilePath);

      const imgRes = await axios({
        url: sourceImageUrl,
        method: 'GET',
        responseType: 'stream',
        timeout: 30000,
      });
      imgRes.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', (err: any) => reject(err));
      });

      /** Đồng bộ sang output.png và source_original.png để dùng lâu dài */
      try {
        fs.copyFileSync(localFilePath, localOutputPath);
        fs.copyFileSync(localFilePath, localSourceOriginal);
      } catch (e) {
        /** Bỏ qua */
      }
    }

    const newImageUrl = `/storage/images/${id}/original.png`;

    /** 5. Cập nhật bài viết thành COMPLETED và đưa thẳng vào hàng đợi tạo video Reel (PENDING) */
    const updated = await this.prisma.ztteam_images.update({
      where: { id },
      data: {
        image_url: newImageUrl,
        template_id: 'source_original',
        status: 'COMPLETED',
        error_log: null,
        video_status: 'PENDING',
      },
    });

    this.eventEmitter.emit('image.updated', updated);

    return {
      success: true,
      message: 'Đã lấy ảnh gốc thành công và đưa vào hàng đợi tạo Video Reel!',
      imageUrl: newImageUrl,
      post: updated,
    };
  }

  /**
   * ZTTeam: Worker báo lỗi khi tạo video thất bại
   * POST /api/image/:id/fail-video
   */
  @Post(':id/fail-video')
  async ztteam_failVideo(@Param('id') id: string, @Body() body: { error?: string }) {
    const updated = await this.prisma.ztteam_images.update({
      where: { id },
      data: {
        video_status: 'FAILED',
        error_log: body.error ? `Muse Video Error: ${body.error}` : 'Muse Video Generation Failed',
      },
    });

    this.eventEmitter.emit('image.updated', updated);

    return { success: true, post: updated };
  }

  /**
   * ZTTeam: Đánh dấu bài viết đã đăng thủ công
   * POST /api/image/:id/mark-posted
   */
  @Post(':id/mark-posted')
  @UseGuards(ZTTeamAuthGuard)
  async ztteam_markPosted(@Param('id') id: string) {
    const img = await this.prisma.ztteam_images.findUnique({
      where: { id },
    });

    if (!img) {
      throw new BadRequestException('Không tìm thấy bài viết');
    }

    const updated = await this.prisma.ztteam_images.update({
      where: { id },
      data: {
        is_posted: true,
        status: 'POSTED',
        posted_at: new Date(),
      },
    });

    this.eventEmitter.emit('image.updated', updated);

    return { success: true, message: 'Đã đánh dấu bài viết là đã đăng thành công', data: updated };
  }
}
