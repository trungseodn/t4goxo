import { Processor, Worker, Job } from 'bullmq';
import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import IORedis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { ZTTeamAIService } from '../ai/ai.service';
import { ZTTeamPuppeteerService } from '../media/puppeteer.service';
import { ZTTeamStoryTestService } from '../story-test/story-test.service';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ztteam_getImagesPath } from '../common/ztteam_storage.util';
import { TelegramService } from '../telegram/telegram.service';
import { ZTTeamWordpressService } from '../wordpress/wordpress.service';
import { ztteam_getNewsComment, ZTTEAM_NEWS_CAPTION_CTA } from '../common/ztteam_news_comment.util';

export interface ZTTeamImageJobData {
  imageId: string;
  pageId: string;
  wpPostId: string;
  templateId: string;
}

@Injectable()
export class ZTTeamImageProcessor implements OnModuleInit {
  private readonly logger = new Logger('ZTTeamImageProcessor');
  private worker: Worker;
  private connection: IORedis;
  private queue: any;
  private readonly storageRoot = ztteam_getImagesPath();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: ZTTeamAIService,
    private readonly puppeteerService: ZTTeamPuppeteerService,
    private readonly eventEmitter: EventEmitter2,
    private readonly telegramService: TelegramService,
    @Inject(forwardRef(() => ZTTeamStoryTestService))
    private readonly storyTestService: ZTTeamStoryTestService,
    private readonly wordpressService: ZTTeamWordpressService,
  ) {}

  onModuleInit() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
    this.connection = new IORedis(redisPort, redisHost, { maxRetriesPerRequest: null });
    const { Queue } = require('bullmq');
    this.queue = new Queue('ztteam-image', { connection: this.connection });

    if (!fs.existsSync(this.storageRoot)) {
      fs.mkdirSync(this.storageRoot, { recursive: true });
    }

    this.worker = new Worker(
      'ztteam-image',
      async (job: Job<ZTTeamImageJobData>) => {
        return this.ztteam_processImageJob(job);
      },
      {
        connection: this.connection,
        concurrency: parseInt(process.env.RENDER_CONCURRENCY || '1', 10),
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Image Job ${job.id} completed successfully`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Image Job ${job?.id} failed: ${err.message}`);
    });

    this.logger.log('Image worker initialized and listening for jobs');
  }

  async ztteam_addJob(data: ZTTeamImageJobData): Promise<string> {
    const job = await this.queue.add('render-image', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    this.logger.log(`Job enqueued: ${job.id} for image ${data.imageId}`);
    return job.id || '';
  }

  private async ztteam_updateImage(id: string, data: any) {
    const updated = await this.prisma.ztteam_images.update({ where: { id }, data });
    this.eventEmitter.emit('image.updated', updated);
    return updated;
  }

  private async ztteam_processImageJob(job: Job<ZTTeamImageJobData>): Promise<void> {
    const { imageId, pageId, wpPostId, templateId } = job.data;
    this.logger.log(`===== START IMAGE RENDER: image=${imageId} =====`);

    await this.ztteam_updateImage(imageId, { status: 'RENDERING', error_log: null });

    const workDir = path.join(this.storageRoot, imageId);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      /** ========== 100% SangTao.ai 2K Pipeline ========== */
      await this.ztteam_processSangTao2kJob(imageId, pageId, wpPostId);
      return;
    } catch (error: any) {
      this.logger.error(`Image render failed for ${imageId}: ${error.message}`);

      let pageName = 'Không rõ';
      let wpPostTitle = 'Không rõ';
      let memberEmail = 'N/A';
      let imageRecord: any = null;
      let targetWpPostId: string | null = wpPostId;

      try {
        imageRecord = await this.prisma.ztteam_images.findUnique({ where: { id: imageId } });
        if (imageRecord) {
          if (imageRecord.wp_post_title) wpPostTitle = imageRecord.wp_post_title;
          if (imageRecord.wp_post_id) targetWpPostId = imageRecord.wp_post_id;
        }
        if (pageId || imageRecord?.page_id) {
          const p = await this.prisma.ztteam_pages.findUnique({
            where: { id: pageId || imageRecord?.page_id },
            include: { fb_account: true, sources: true }
          });
          if (p) {
            pageName = p.name;
            if (p.fb_account?.owner_user_id) {
              const u = await this.prisma.ztteam_users.findUnique({
                where: { id: p.fb_account.owner_user_id },
                select: { email: true }
              });
              if (u) memberEmail = u.email;
            }
          }
        }
      } catch (e) {
        /** ignore */
      }

      const currentRetries = ((imageRecord?.post_retry_count || 0) + 1);

      /** If failed 3 times: Delete post from WordPress, mark as FAILED, stop retrying */
      if (currentRetries >= 3) {
        this.logger.warn(`Image ${imageId} failed 3 times. Deleting post #${targetWpPostId} from WordPress...`);
        let postDeleted = false;

        if (targetWpPostId) {
          try {
            const page = await this.prisma.ztteam_pages.findUnique({
              where: { id: pageId || imageRecord?.page_id },
              include: { sources: true }
            });
            const source = page?.sources?.[0];
            if (source?.target_site_id) {
              const wpSite = await this.prisma.ztteam_target_sites.findUnique({
                where: { id: source.target_site_id }
              });
              if (wpSite) {
                const authHeader = this.wordpressService.ztteam_getAuthHeader(wpSite);
                const wpUrl = wpSite.wp_url.replace(/\/$/, '');
                postDeleted = await this.wordpressService.ztteam_deletePost(wpUrl, authHeader, targetWpPostId);
              }
            }
          } catch (delErr: any) {
            this.logger.error(`Error deleting post #${targetWpPostId} on WordPress: ${delErr.message}`);
          }
        }

        await this.ztteam_updateImage(imageId, {
          status: 'FAILED',
          post_retry_count: currentRetries,
          error_log: `Tạo ảnh AI thất bại 3 lần liên tiếp: ${error.message}.${postDeleted ? ` Đã tự động xóa bài viết #${targetWpPostId} khỏi WordPress.` : ''}`,
        });

        this.telegramService.ztteam_sendMessage(
          `🚨 *[LỖI TẠO ẢNH 3 LẦN - ĐÃ XÓA BÀI VIẾT TRÊN WORDPRESS]*\n\n` +
          `👤 *Thành viên:* ${memberEmail}\n` +
          `🚩 *Fanpage:* ${pageName}\n` +
          `🖼 *Ảnh:* ${wpPostTitle} (WP Post #${targetWpPostId || 'N/A'})\n` +
          `🗑 *Hành động:* ${postDeleted ? 'Đã xóa vĩnh viễn bài viết khỏi WordPress' : 'Không thể xóa bài trên WordPress'}\n` +
          `❌ *Chi tiết lỗi:* ${error.message}`
        );

        return;
      } else {
        await this.ztteam_updateImage(imageId, {
          status: 'FAILED',
          post_retry_count: currentRetries,
          error_log: `Lần thử ${currentRetries}/3 thất bại: ${error.message || 'Unknown error'}`,
        });

        this.telegramService.ztteam_sendMessage(
          `🚨 *[LỖI TẠO ẢNH AI (Lần ${currentRetries}/3)]*\n\n` +
          `👤 *Thành viên:* ${memberEmail}\n` +
          `🚩 *Fanpage:* ${pageName}\n` +
          `🖼 *Ảnh:* ${wpPostTitle}\n` +
          `❌ *Chi tiết lỗi:* ${error.message}`
        );

        throw error;
      }
    }
  }

  /**
   * Render or Re-render 2K Image using SangTao.ai with modern 2026 prompt
   * Deletes old local image and old WordPress media, uploads new 2K image, and updates featured_media
   */
  private async ztteam_processSangTao2kJob(imageId: string, pageId: string, wpPostId: string): Promise<void> {
    this.logger.log(`Executing SangTao.ai 2K render for image ${imageId}`);
    const image = await this.prisma.ztteam_images.findUnique({
      where: { id: imageId },
      include: { page: true },
    });
    if (!image) throw new Error('Image record not found');

    const workDir = path.join(this.storageRoot, imageId);
    if (fs.existsSync(workDir)) {
      try {
        const files = fs.readdirSync(workDir);
        for (const file of files) {
          try { fs.unlinkSync(path.join(workDir, file)); } catch (e) {}
        }
      } catch (e) {}
    } else {
      fs.mkdirSync(workDir, { recursive: true });
    }

    let storyContent = image.wp_post_title || '';
    if (image.ai_caption) {
      storyContent += '\n\n' + image.ai_caption;
    }

    let wpSite: any = null;
    let wpPostData: any = null;
    let authHeader: string | null = null;
    let wpUrl: string | null = null;

    /** Try fetching full story content and post metadata from WordPress */
    if (wpPostId) {
      try {
        const effectivePageId = pageId || image.page_id;
        const page = effectivePageId
          ? await this.prisma.ztteam_pages.findUnique({
              where: { id: effectivePageId },
              include: { sources: true },
            })
          : null;
        const source = page?.sources?.[0];
        if (source?.target_site_id) {
          wpSite = await this.prisma.ztteam_target_sites.findUnique({
            where: { id: source.target_site_id },
          });
          if (wpSite) {
            authHeader = this.wordpressService.ztteam_getAuthHeader(wpSite);
            wpUrl = wpSite.wp_url.replace(/\/$/, '');
            const res = await axios.get(`${wpUrl}/wp-json/wp/v2/posts/${wpPostId}`, {
              headers: { Authorization: authHeader },
              timeout: 15000,
            });
            wpPostData = res.data;
            if (wpPostData?.content?.rendered) {
              const cleanText = wpPostData.content.rendered.replace(/<[^>]+>/g, ' ').trim();
              storyContent = (wpPostData.title?.rendered || image.wp_post_title || '') + '\n\n' + cleanText;
            }
          }
        }
      } catch (err: any) {
        this.logger.warn(`Could not fetch full post from WP: ${err.message}, using fallback text`);
      }
    }

    /** If WordPress post has old featured_media, delete it from WordPress media library */
    if (wpPostData?.featured_media && wpUrl && authHeader) {
      try {
        this.logger.log(`Deleting old featured_media #${wpPostData.featured_media} on WordPress...`);
        await this.wordpressService.ztteam_deleteMedia(wpUrl, authHeader, wpPostData.featured_media);
      } catch (delErr: any) {
        this.logger.warn(`Failed to delete old media on WP: ${delErr.message}`);
      }
    }

    /** 1. Generate modern 2026 realistic prompt bám sát kịch bản */
    const promptData = await this.storyTestService.ztteam_generateStoryImagePrompt(
      storyContent,
      'cinematic',
      '4:5',
    );

    /** 2. Render 2K Image via SangTao.ai */
    const imageResult = await this.storyTestService.ztteam_renderStoryImage({
      prompt: promptData.image_prompt_en,
      aspectRatio: '4:5',
    });

    /** 3. Copy image to local work directory */
    const localDestPath = path.join(workDir, 'output.png');
    if (imageResult.localPath && fs.existsSync(imageResult.localPath)) {
      try {
        fs.copyFileSync(imageResult.localPath, localDestPath);
      } catch (cpErr: any) {
        this.logger.warn(`Failed to copy local image: ${cpErr.message}`);
      }
    }

    /** 4. Upload newly rendered 2K image to WordPress & update post featured_media */
    let uploadedMediaUrl: string | null = null;
    if (wpUrl && authHeader && wpPostId) {
      try {
        this.logger.log(`Uploading new 2K image to WordPress for post #${wpPostId}...`);
        let imgBuffer: Buffer;
        if (imageResult.localPath && fs.existsSync(imageResult.localPath)) {
          imgBuffer = fs.readFileSync(imageResult.localPath);
        } else {
          const dl = await axios.get(imageResult.imageUrl, { responseType: 'arraybuffer' });
          imgBuffer = Buffer.from(dl.data);
        }
        const filename = `story_2k_${imageId}_${Date.now()}.jpg`;
        const uploadedMedia = await this.wordpressService.ztteam_uploadMedia(
          wpUrl,
          authHeader,
          imgBuffer,
          filename,
          'image/jpeg',
        );
        uploadedMediaUrl = uploadedMedia.source_url;
        this.logger.log(`Uploaded media #${uploadedMedia.id} (${uploadedMedia.source_url})`);

        await this.wordpressService.ztteam_updatePostFeaturedMedia(
          wpUrl,
          authHeader,
          wpPostId,
          uploadedMedia.id,
        );
      } catch (wpErr: any) {
        this.logger.error(`Failed to upload media or update featured_media on WP: ${wpErr.message}`);
      }
    }

    /** 5. Update database record */
    const localUrl = `/storage/images/${imageId}/output.png`;

    /** ZTTeam: Kiểm tra xem bài viết đã có Caption và Comment chuẩn hay chưa */
    const isCurrentCaptionValid = Boolean(
      image.ai_caption &&
      !image.ai_caption.includes('Stay tuned for the full story') &&
      !image.ai_caption.includes('What happens next will change everything')
    );

    const isCurrentCommentValid = Boolean(
      image.ai_first_comment &&
      !image.ai_first_comment.includes('yourwebsite.com')
    );

    let finalCaption = image.ai_caption;
    let finalComment = image.ai_first_comment;

    /** ZTTeam: Nếu caption hoặc comment chưa chuẩn, tự động sinh theo chuẩn True-Crime Cold Case */
    if (!isCurrentCaptionValid || !isCurrentCommentValid) {
      const storyTitle = wpPostData?.title?.rendered || image.wp_post_title || '';
      let rawContent = '';
      if (wpPostData?.content?.rendered) {
        rawContent = wpPostData.content.rendered.replace(/<[^>]+>/g, ' ').trim();
      } else {
        rawContent = storyContent;
      }
      const postUrl = wpPostData?.link || image.wp_post_url || '';

      try {
        const pagePrompt = (image.page as any)?.ai_custom_prompt || null;
        const coldCase = await this.aiService.ztteam_generateColdCaseContent(
          storyTitle,
          rawContent,
          pagePrompt,
          postUrl
        );
        if (!isCurrentCaptionValid) {
          finalCaption = coldCase.fullCaption;
        }
        if (!isCurrentCommentValid) {
          finalComment = coldCase.commentText;
        }
      } catch (aiErr: any) {
        this.logger.warn(`AI Cold Case generation error in image.processor, using fallback: ${aiErr.message}`);
        const titleUppercase = storyTitle.toUpperCase();
        const { part1 } = this.ztteam_extractStoryParts(rawContent, 900, 700);
        if (!isCurrentCaptionValid) {
          const captionCTA = ZTTEAM_NEWS_CAPTION_CTA;
          finalCaption = part1 ? `${titleUppercase}\n\n${part1}\n\n${captionCTA}` : `${titleUppercase}\n\n${captionCTA}`;
        }
        if (!isCurrentCommentValid) {
          finalComment = ztteam_getNewsComment(postUrl);
        }
      }
    }

    await this.ztteam_updateImage(imageId, {
      status: 'COMPLETED',
      image_url: localUrl,
      template_id: 'sangtao_2k',
      ai_caption: finalCaption,
      ai_first_comment: finalComment,
      error_log: null,
    });

    this.logger.log(`===== SANGTAO 2K RENDER COMPLETE: image=${imageId}, local=${localUrl}, wp=${uploadedMediaUrl || 'N/A'} =====`);
  }

  /**
   * ZTTeam: Trích xuất Part 1 và Part 2 chuẩn Facebook Viral
   */
  private ztteam_extractStoryParts(
    content: string,
    maxPart1Chars: number = 900,
    maxPart2Chars: number = 700
  ): { part1: string; part2: string } {
    if (!content) return { part1: '', part2: '' };

    let cleaned = content.replace(/^Part\s*1\s*[:\-]\s*/i, '').trim();

    /** Trường hợp bài viết có đánh dấu Part 1 và Part 2 rõ ràng */
    const part2Regex = /Part\s*2\s*[:\-]/i;
    const part2Match = cleaned.match(part2Regex);

    if (part2Match && part2Match.index && part2Match.index > 100) {
      let part1 = cleaned.substring(0, part2Match.index).trim();
      let remainder = cleaned.substring(part2Match.index).trim();

      remainder = remainder.replace(/^Part\s*2\s*[:\-]\s*/i, '').trim();

      const part3Match = remainder.match(/Part\s*3\s*[:\-]/i);
      let part2Raw = part3Match && part3Match.index ? remainder.substring(0, part3Match.index).trim() : remainder;

      let part2 = part2Raw;
      if (part2.length > maxPart2Chars) {
        const slice = part2.substring(0, maxPart2Chars);
        const lastPeriod = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'));
        if (lastPeriod > 150) {
          part2 = slice.substring(0, lastPeriod + 1).trim();
        } else {
          part2 = slice.trim() + '...';
        }
      }

      return { part1, part2 };
    }

    /** Trường hợp câu chuyện liền mạch không có chữ Part 1, Part 2 */
    let part1 = cleaned;
    let remainder = '';

    if (cleaned.length > maxPart1Chars) {
      const slice = cleaned.substring(0, maxPart1Chars);
      const lastPeriod = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'));
      if (lastPeriod > 200) {
        part1 = slice.substring(0, lastPeriod + 1).trim();
        remainder = cleaned.substring(lastPeriod + 1).trim();
      } else {
        part1 = slice.trim();
        remainder = cleaned.substring(maxPart1Chars).trim();
      }
    }

    let part2 = '';
    if (remainder) {
      if (remainder.length > maxPart2Chars) {
        const slice = remainder.substring(0, maxPart2Chars);
        const lastPeriod = Math.max(slice.lastIndexOf('.'), slice.lastIndexOf('!'), slice.lastIndexOf('?'));
        if (lastPeriod > 150) {
          part2 = slice.substring(0, lastPeriod + 1).trim();
        } else {
          part2 = slice.trim() + '...';
        }
      } else {
        part2 = remainder;
      }
    }

    return { part1, part2 };
  }

  private async ztteam_step1_fetchData(pageId: string, wpPostId: string, templateId: string) {
    let page = await this.prisma.ztteam_pages.findUnique({
      where: { id: pageId },
      include: { sources: true, fb_account: true },
    });

    if (!page) throw new Error(`Page ${pageId} not found`);

    const source = page.sources[0];
    if (!source) throw new Error('Fanpage chưa được cấu hình Nguồn bài viết (WordPress) nào trong phần Cài đặt.');

    let post = { content: '', excerpt: '', images: [] as string[], title: '' };
    const site = await this.prisma.ztteam_target_sites.findUnique({
      where: { id: source.target_site_id },
    });

    if (site) {
      try {
        const wpUrl = site.wp_url.replace(/\/$/, '');
        const res = await axios.get(`${wpUrl}/wp-json/wp/v2/posts/${wpPostId}`, { timeout: 15000 });
        const wpPost = res.data;
        post.title = wpPost.title?.rendered || '';
        post.content = (wpPost.content?.rendered || '').replace(/<[^>]+>/g, ' ').trim();
        post.excerpt = (wpPost.excerpt?.rendered || post.content.substring(0, 150) + '...').replace(/<[^>]+>/g, ' ').trim();

        const imgRegex = /<img[^>]+(?:src|data-src)="([^"]+)"/gi;
        let match;
        while ((match = imgRegex.exec(wpPost.content?.rendered || '')) !== null) {
          post.images.push(match[1]);
        }

        /** Lọc trùng lặp ảnh */
        post.images = [...new Set(post.images)];
      } catch (error) {
        throw new Error('Lỗi lấy bài viết từ WP');
      }
    }

    if (post.images.length === 0) {
      post.images.push('https://placehold.co/1080x1080/2563eb/white?text=No+Image');
    }

    let finalTemplateId = templateId;
    if (templateId === 'auto' || templateId === 'default' || !templateId) {
      const imgCount = post.images.length;
      
      const allImageTemplates = await this.prisma.ztteam_templates.findMany({
        where: { format: 'image' }
      });
      
      if (allImageTemplates.length > 0) {
        const validTemplates = allImageTemplates.filter(t => {
          let needed = 3; /** split_2 needs 3 images (2 + 1 inset) */
          if (t.content_type === 'split_3' || t.name.includes('3')) needed = 4;
          if (t.content_type === 'split_4' || t.name.includes('4')) needed = 5;
          return needed <= imgCount;
        });

        if (validTemplates.length > 0) {
          const randomTemplate = validTemplates[Math.floor(Math.random() * validTemplates.length)];
          finalTemplateId = randomTemplate.id;
        } else {
          /** Fallback to the smallest template if post has too few images */
          const fallback = allImageTemplates.find(t => t.content_type === 'split_2' || t.name.includes('2')) || allImageTemplates[0];
          finalTemplateId = fallback.id;
        }
      }

      /** Shuffle images to ensure random selection each time to avoid duplicating layouts */
      if (post.images.length > 0) {
        for (let i = post.images.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [post.images[i], post.images[j]] = [post.images[j], post.images[i]];
        }
      }
    }

    const template = await this.prisma.ztteam_templates.findUnique({
      where: { id: finalTemplateId },
    });
    if (!template) throw new Error(`Template ${finalTemplateId} not found`);

    return { page, template, post };
  }

  private async ztteam_step2_downloadImages(imageUrls: string[], workDir: string): Promise<string[]> {
    const localPaths: string[] = [];
    const maxImages = 5; /** Chỉ lấy tối đa 5 ảnh để chèn */
    
    for (let i = 0; i < Math.min(imageUrls.length, maxImages); i++) {
      const imgUrl = imageUrls[i];
      const localPath = path.join(workDir, `img_${i}.jpg`);
      
      try {
        if (imgUrl.startsWith('http')) {
          const response = await axios({ url: imgUrl, responseType: 'stream', timeout: 10000 });
          const writer = fs.createWriteStream(localPath);
          response.data.pipe(writer);
          await new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(undefined));
            writer.on('error', reject);
          });
          /** For base64 usage in Puppeteer, we need file:// protocol or base64 data */
          const base64 = fs.readFileSync(localPath, { encoding: 'base64' });
          const ext = imgUrl.split('.').pop()?.toLowerCase() === 'png' ? 'png' : 'jpeg';
          localPaths.push(`data:image/${ext};base64,${base64}`);
        } else {
          localPaths.push(imgUrl);
        }
      } catch (e) {
        this.logger.warn(`Failed to download image ${imgUrl}`);
      }
    }
    
    /** Padding missing images with placeholders if the template uses them */
    if (localPaths.length > 0) {
      while (localPaths.length < 5) {
        const randomExisting = localPaths[Math.floor(Math.random() * localPaths.length)];
        localPaths.push(randomExisting);
      }
    } else {
      while (localPaths.length < 5) {
        localPaths.push('https://placehold.co/1080x1080/f1f5f9/9ca3af?text=No+Image');
      }
    }
    
    return localPaths;
  }

  private async ztteam_step3_renderOverlay(template: any, page: any, post: any, images: string[], workDir: string): Promise<string> {
    const outputPath = path.join(workDir, 'output.png');
    let finalHtml = template.html_content;
    

    /** Xử lý template thay thế biến */
    finalHtml = finalHtml.replace(/\{\{title\}\}/g, () => (post.title || ''));
    finalHtml = finalHtml.replace(/\{\{excerpt\}\}/g, () => (post.excerpt || ''));
    finalHtml = finalHtml.replace(/\{\{site_name\}\}/g, () => (page.name || ''));
    finalHtml = finalHtml.replace(/\{\{logo_url\}\}/g, () => (page.avatar || ''));

    const headerX = template.layout?.header?.x !== undefined ? template.layout.header.x : 40;
    const headerY = template.layout?.header?.y !== undefined ? template.layout.header.y : 850;
    finalHtml = finalHtml.replace(/\{\{layout\.header\.x\}\}/g, String(headerX));
    finalHtml = finalHtml.replace(/\{\{layout\.header\.y\}\}/g, String(headerY));

    const breakingX = template.layout?.breaking?.x !== undefined ? template.layout.breaking.x : 10;
    const breakingY = template.layout?.breaking?.y !== undefined ? template.layout.breaking.y : 10;
    finalHtml = finalHtml.replace(/\{\{layout\.breaking\.x\}\}/g, String(breakingX));
    finalHtml = finalHtml.replace(/\{\{layout\.breaking\.y\}\}/g, String(breakingY));

    const hookX = template.layout?.hook?.x !== undefined ? template.layout.hook.x : 40;
    const hookY = template.layout?.hook?.y !== undefined ? template.layout.hook.y : 950;
    finalHtml = finalHtml.replace(/\{\{layout\.hook\.x\}\}/g, String(hookX));
    finalHtml = finalHtml.replace(/\{\{layout\.hook\.y\}\}/g, String(hookY));

    
    /** Xử lý ẩn hiện phần tử theo layout */
    if (template.layout?.hide_title) {
      finalHtml = finalHtml.replace(/class="header"/g, 'class="header" style="display: none !important;"');
      finalHtml = finalHtml.replace(/class="text-overlay"/g, 'class="text-overlay" style="display: none !important;"');
    }
    if (template.layout?.hide_excerpt) {
      finalHtml = finalHtml.replace(/class="hook"/g, 'class="hook" style="display: none !important;"');
    }
    
    /** Xử lý thay thế URL ảnh */
    for (let i = 0; i < images.length; i++) {
      finalHtml = finalHtml.replace(new RegExp(`\\{\\{image_${i + 1}\\}\\}`, 'g'), images[i]);
    }

    /** RANDOMIZE INSET AND ARROW POSITIONS */
    if (template.format === 'image') {
      const insetRegex = /<div class="inset">[\s\S]*?<\/div>/;
      const arrowRegex = /<svg class="arrow"[\s\S]*?<\/svg>/;
      
      const matchInset = finalHtml.match(insetRegex);
      const matchArrow = finalHtml.match(arrowRegex);

      if (matchInset && matchArrow) {
        finalHtml = finalHtml.replace(insetRegex, '');
        finalHtml = finalHtml.replace(arrowRegex, '');
        
        const positions = [
          /** 1: Center */
          { cluster: 'top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.8); transform-origin: center;', arrow: 'top: 5px !important; left: -124px !important; transform: rotate(15deg) !important;' },
          /** 2: Top-Center */
          { cluster: 'top: 20px; left: 50%; transform: translateX(-50%) scale(0.8); transform-origin: top center;', arrow: 'bottom: 5px !important; right: -124px !important; transform: scaleX(-1) scaleY(-1) rotate(15deg) !important;' },
          /** 3: Bottom-Center */
          { cluster: 'bottom: 20px; left: 50%; transform: translateX(-50%) scale(0.8); transform-origin: bottom center;', arrow: 'top: 5px !important; left: -124px !important; transform: rotate(15deg) !important;' },
          /** 4: Left-Center */
          { cluster: 'top: 50%; left: 20px; transform: translateY(-50%) scale(0.8); transform-origin: left center;', arrow: 'top: 5px !important; right: -124px !important; transform: scaleX(-1) rotate(-15deg) !important;' },
          /** 5: Right-Center */
          { cluster: 'top: 50%; right: 20px; transform: translateY(-50%) scale(0.8); transform-origin: right center;', arrow: 'bottom: 5px !important; left: -124px !important; transform: scaleY(-1) rotate(-15deg) !important;' },
        ];
        const randomPos = positions[Math.floor(Math.random() * positions.length)];
        
        finalHtml += `
        <div class="random-cluster" style="position: absolute; width: 400px; height: 400px; z-index: 20; ${randomPos.cluster}">
          ${matchInset[0]}
          ${matchArrow[0]}
        </div>
        <style>
          .random-cluster .inset { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; transform: none !important; margin: 0 !important; border-color: #ff0033 !important; }
          .random-cluster .arrow { position: absolute !important; top: auto !important; bottom: auto !important; left: auto !important; right: auto !important; width: 200px !important; height: 200px !important; margin: 0 !important; ${randomPos.arrow} }
        </style>
        `;
      }
    }

    const width = (template.layout as any)?.width || 1080;
    const height = (template.layout as any)?.height || 1080;
    
    await this.puppeteerService.ztteam_renderOverlay(finalHtml, outputPath, width, height);
    return outputPath;
  }

  async ztteam_testRender(templateId: string, title: string, images: string[]): Promise<string> {
    const template = await this.prisma.ztteam_templates.findUnique({ where: { id: templateId } });
    if (!template) throw new Error('Template not found');

    const fileName = `test_render_${Date.now()}.png`;
    const outputPath = path.join(ztteam_getImagesPath(), fileName);

    let finalHtml = template.html_content;

    /** Pad images to 5 using existing images or placeholders */
    if (images.length > 0) {
      while (images.length < 5) {
        const randomExisting = images[Math.floor(Math.random() * images.length)];
        images.push(randomExisting);
      }
    } else {
      while (images.length < 5) {
        images.push('https://placehold.co/1080x1080/f1f5f9/9ca3af?text=No+Image');
      }
    }

    finalHtml = finalHtml.replace(/\{\{title\}\}/g, () => (title || ''));
    finalHtml = finalHtml.replace(/\{\{excerpt\}\}/g, () => (title || ''));
    finalHtml = finalHtml.replace(/\{\{site_name\}\}/g, () => ('Test Page'));
    finalHtml = finalHtml.replace(/\{\{logo_url\}\}/g, () => (''));

    for (let i = 0; i < images.length; i++) {
      finalHtml = finalHtml.replace(new RegExp(`\\{\\{image_${i + 1}\\}\\}`, 'g'), images[i]);
    }

    /** RANDOMIZE INSET AND ARROW POSITIONS */
    if (template.format === 'image') {
      const insetRegex = /<div class="inset">[\s\S]*?<\/div>/;
      const arrowRegex = /<svg class="arrow"[\s\S]*?<\/svg>/;
      
      const matchInset = finalHtml.match(insetRegex);
      const matchArrow = finalHtml.match(arrowRegex);

      if (matchInset && matchArrow) {
        finalHtml = finalHtml.replace(insetRegex, '');
        finalHtml = finalHtml.replace(arrowRegex, '');
        
        const positions = [
          { cluster: 'top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.8); transform-origin: center;', arrow: 'top: 5px !important; left: -124px !important; transform: rotate(15deg) !important;' },
          { cluster: 'top: 20px; left: 50%; transform: translateX(-50%) scale(0.8); transform-origin: top center;', arrow: 'bottom: 5px !important; right: -124px !important; transform: scaleX(-1) scaleY(-1) rotate(15deg) !important;' },
          { cluster: 'bottom: 20px; left: 50%; transform: translateX(-50%) scale(0.8); transform-origin: bottom center;', arrow: 'top: 5px !important; left: -124px !important; transform: rotate(15deg) !important;' },
          { cluster: 'top: 50%; left: 20px; transform: translateY(-50%) scale(0.8); transform-origin: left center;', arrow: 'top: 5px !important; right: -124px !important; transform: scaleX(-1) rotate(-15deg) !important;' },
          { cluster: 'top: 50%; right: 20px; transform: translateY(-50%) scale(0.8); transform-origin: right center;', arrow: 'bottom: 5px !important; left: -124px !important; transform: scaleY(-1) rotate(-15deg) !important;' },
        ];
        const randomPos = positions[Math.floor(Math.random() * positions.length)];
        
        finalHtml += `
        <div class="random-cluster" style="position: absolute; width: 400px; height: 400px; z-index: 20; ${randomPos.cluster}">
          ${matchInset[0]}
          ${matchArrow[0]}
        </div>
        <style>
          .random-cluster .inset { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; transform: none !important; margin: 0 !important; border-color: #ff0033 !important; }
          .random-cluster .arrow { position: absolute !important; top: auto !important; bottom: auto !important; left: auto !important; right: auto !important; width: 200px !important; height: 200px !important; margin: 0 !important; ${randomPos.arrow} }
        </style>
        `;
      }
    }

    const width = (template.layout as any)?.width || 1080;
    const height = (template.layout as any)?.height || 1080;

    await this.puppeteerService.ztteam_renderOverlay(finalHtml, outputPath, width, height);
    return `/storage/images/${fileName}`;
  }

  async ztteam_testRenderQueueItem(imageId: string): Promise<string> {
    const image = await this.prisma.ztteam_images.findUnique({ where: { id: imageId } });
    if (!image) throw new Error('Queue item not found');

    if (!image.page_id) throw new Error('Bài viết không thuộc Fanpage nào');

    const page = await this.prisma.ztteam_pages.findUnique({ where: { id: image.page_id } });
    if (!page) throw new Error('Page not found');

    const { template, post } = await this.ztteam_step1_fetchData(image.page_id, image.wp_post_id, image.template_id);
    
    let imageUrls: string[] = post.images || [];

    const fileName = `test_render_${Date.now()}.png`;
    const outputPath = path.join(ztteam_getImagesPath(), fileName);

    let finalHtml = template.html_content;

    /** Pad images to 5 using existing images or placeholders */
    if (imageUrls.length > 0) {
      while (imageUrls.length < 5) {
        const randomExisting = imageUrls[Math.floor(Math.random() * imageUrls.length)];
        imageUrls.push(randomExisting);
      }
    } else {
      while (imageUrls.length < 5) {
        imageUrls.push('https://placehold.co/1080x1080/f1f5f9/9ca3af?text=No+Image');
      }
    }

    finalHtml = finalHtml.replace(/\{\{title\}\}/g, () => (post.title || ''));
    finalHtml = finalHtml.replace(/\{\{excerpt\}\}/g, () => (post.excerpt || ''));
    finalHtml = finalHtml.replace(/\{\{site_name\}\}/g, () => (page.name || 'Test Page'));
    finalHtml = finalHtml.replace(/\{\{logo_url\}\}/g, () => (page.avatar || ''));

    for (let i = 0; i < imageUrls.length; i++) {
      finalHtml = finalHtml.replace(new RegExp(`\\{\\{image_${i + 1}\\}\\}`, 'g'), imageUrls[i]);
    }

    /** RANDOMIZE INSET AND ARROW POSITIONS */
    if (template.format === 'image') {
      const insetRegex = /<div class="inset">[\s\S]*?<\/div>/;
      const arrowRegex = /<svg class="arrow"[\s\S]*?<\/svg>/;
      
      const matchInset = finalHtml.match(insetRegex);
      const matchArrow = finalHtml.match(arrowRegex);

      if (matchInset && matchArrow) {
        finalHtml = finalHtml.replace(insetRegex, '');
        finalHtml = finalHtml.replace(arrowRegex, '');
        
        const positions = [
          { cluster: 'top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.8); transform-origin: center;', arrow: 'top: 5px !important; left: -124px !important; transform: rotate(15deg) !important;' },
          { cluster: 'top: 20px; left: 50%; transform: translateX(-50%) scale(0.8); transform-origin: top center;', arrow: 'bottom: 5px !important; right: -124px !important; transform: scaleX(-1) scaleY(-1) rotate(15deg) !important;' },
          { cluster: 'bottom: 20px; left: 50%; transform: translateX(-50%) scale(0.8); transform-origin: bottom center;', arrow: 'top: 5px !important; left: -124px !important; transform: rotate(15deg) !important;' },
          { cluster: 'top: 50%; left: 20px; transform: translateY(-50%) scale(0.8); transform-origin: left center;', arrow: 'top: 5px !important; right: -124px !important; transform: scaleX(-1) rotate(-15deg) !important;' },
          { cluster: 'top: 50%; right: 20px; transform: translateY(-50%) scale(0.8); transform-origin: right center;', arrow: 'bottom: 5px !important; left: -124px !important; transform: scaleY(-1) rotate(-15deg) !important;' },
        ];
        const randomPos = positions[Math.floor(Math.random() * positions.length)];
        
        finalHtml += `
        <div class="random-cluster" style="position: absolute; width: 400px; height: 400px; z-index: 20; ${randomPos.cluster}">
          ${matchInset[0]}
          ${matchArrow[0]}
        </div>
        <style>
          .random-cluster .inset { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; transform: none !important; margin: 0 !important; border-color: #ff0033 !important; }
          .random-cluster .arrow { position: absolute !important; top: auto !important; bottom: auto !important; left: auto !important; right: auto !important; width: 200px !important; height: 200px !important; margin: 0 !important; ${randomPos.arrow} }
        </style>
        `;
      }
    }

    const width = (template.layout as any)?.width || 1080;
    const height = (template.layout as any)?.height || 1080;

    await this.puppeteerService.ztteam_renderOverlay(finalHtml, outputPath, width, height);
    return `/storage/images/${fileName}`;
  }
}
