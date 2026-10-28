import { Injectable, Logger, HttpException, HttpStatus, Inject, forwardRef } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../prisma/prisma.service';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import sharp from 'sharp';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ZTTeamHtmlCleanerService } from './html-cleaner.service';
import { ztteam_getStorageRoot, ztteam_getImagesPath } from '../common/ztteam_storage.util';
import { ztteam_getNewsComment, ZTTEAM_NEWS_CAPTION_CTA } from '../common/ztteam_news_comment.util';
import { ZTTeamHookVideoService } from '../media/hook-video.service';

@Injectable()
export class ZTTeamWordpressService {
  private readonly logger = new Logger(ZTTeamWordpressService.name);
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly htmlCleaner: ZTTeamHtmlCleanerService,
    @Inject(forwardRef(() => ZTTeamHookVideoService))
    private readonly hookVideoService: ZTTeamHookVideoService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const secret = process.env.JWT_SECRET || 'default-secret-key-32-chars-long!';
    this.encryptionKey = crypto.scryptSync(secret, 'salt', 32);
  }

  private ztteam_encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  private ztteam_decrypt(encryptedText: string): string {
    if (!encryptedText) return '';
    const [ivHex, encrypted] = encryptedText.split(':');
    if (!ivHex || !encrypted) return encryptedText;

    /** 1. Thử giải mã với khóa cấu hình hiện tại */
    try {
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      /** Tiếp tục thử với các khóa dự phòng */
    }

    /** 2. Thử giải mã với default secret key */
    try {
      const fallbackKey = crypto.scryptSync('default-secret-key-32-chars-long!', 'salt', 32);
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', fallbackKey, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      /** Tiếp tục thử với khóa production */
    }

    /** 3. Thử với key ZTREEL_SECRET_KEY_2026 */
    try {
      const fallbackKey2 = crypto.scryptSync('ZTREEL_SECRET_KEY_2026', 'salt', 32);
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', fallbackKey2, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err: any) {
      this.logger.warn(`Decryption failed: ${err.message}.`);
      return encryptedText;
    }
  }

  async ztteam_testConnection(wpUrl: string, wpUsername: string, wpAppPassword: string) {
    try {
      const cleanUrl = wpUrl.replace(/\/$/, '');
      const authHeader = 'Basic ' + Buffer.from(`${wpUsername}:${wpAppPassword}`).toString('base64');

      const response = await firstValueFrom(
        this.httpService.get(`${cleanUrl}/wp-json/wp/v2/users/me`, {
          headers: {
            Authorization: authHeader,
          },
        })
      );

      return { success: true, data: { id: response.data.id, name: response.data.name } };
    } catch (error: any) {
      this.logger.error('WordPress connection test failed', error.response?.data || error.message);
      throw new HttpException(
        error.response?.data?.message || 'Failed to connect to WordPress',
        HttpStatus.BAD_REQUEST
      );
    }
  }

  /** Pre-flight check: Xác thực trang WordPress đích trước khi gọi AI tạo ảnh tốn phí */
  async ztteam_verifySite(targetSiteId: string): Promise<boolean> {
    const site = await this.prisma.ztteam_target_sites.findUnique({ where: { id: targetSiteId } });
    if (!site) throw new HttpException(`Target site ${targetSiteId} not found`, HttpStatus.BAD_REQUEST);
    const decryptedPassword = this.ztteam_decrypt(site.wp_app_password_encrypted);
    await this.ztteam_testConnection(site.wp_url, site.wp_username, decryptedPassword);
    return true;
  }

  async ztteam_createTargetSite(userId: string, data: { wpUrl: string; wpUsername: string; wpAppPassword: string; isManual?: boolean; ga4PropertyId?: string }) {
    await this.ztteam_testConnection(data.wpUrl, data.wpUsername, data.wpAppPassword);

    return this.prisma.ztteam_target_sites.create({
      data: {
        owner_user_id: userId,
        wp_url: data.wpUrl,
        wp_username: data.wpUsername,
        wp_app_password_encrypted: this.ztteam_encrypt(data.wpAppPassword),
        status: 'active',
        is_manual: data.isManual ?? false,
        ga4_property_id: data.ga4PropertyId ? data.ga4PropertyId.trim() : null,
      }
    });
  }

  async ztteam_updateTargetSite(userId: string, siteId: string, data: { wpUrl: string; wpUsername: string; wpAppPassword?: string; isManual?: boolean; ga4PropertyId?: string }) {
    if (data.wpAppPassword) {
      await this.ztteam_testConnection(data.wpUrl, data.wpUsername, data.wpAppPassword);
    }

    const updateData: any = {
      wp_url: data.wpUrl,
      wp_username: data.wpUsername,
    };

    if (data.isManual !== undefined) {
      updateData.is_manual = data.isManual;
    }

    if (data.ga4PropertyId !== undefined) {
      updateData.ga4_property_id = data.ga4PropertyId ? data.ga4PropertyId.trim() : null;
    }

    if (data.wpAppPassword) {
      updateData.wp_app_password_encrypted = this.ztteam_encrypt(data.wpAppPassword);
    }

    return this.prisma.ztteam_target_sites.update({
      where: { id: siteId, owner_user_id: userId },
      data: updateData
    });
  }

  /** ZTTeam: Bật / Tắt nhanh chế độ Đăng Thủ Công cho Website WordPress đích */
  async ztteam_toggleSiteManual(userId: string, siteId: string, isManual: boolean) {
    const site = await this.prisma.ztteam_target_sites.findFirst({
      where: { id: siteId, owner_user_id: userId }
    });

    if (!site) {
      throw new HttpException('Website WordPress không tồn tại hoặc bạn không có quyền', HttpStatus.NOT_FOUND);
    }

    return this.prisma.ztteam_target_sites.update({
      where: { id: siteId },
      data: { is_manual: isManual }
    });
  }

  async ztteam_getTargetSites(userId: string) {
    return this.prisma.ztteam_target_sites.findMany({
      where: { owner_user_id: userId },
      select: {
        id: true,
        wp_url: true,
        wp_username: true,
        status: true,
        is_manual: true,
        created_at: true,
        updated_at: true,
        _count: {
          select: { crawl_sources: true }
        }
      }
    });
  }

  async ztteam_deleteTargetSite(userId: string, siteId: string) {
    return this.prisma.ztteam_target_sites.deleteMany({
      where: { id: siteId, owner_user_id: userId }
    });
  }

  ztteam_getAuthHeader(site: any): string {
    const wpAppPassword = this.ztteam_decrypt(site.wp_app_password_encrypted);
    return 'Basic ' + Buffer.from(`${site.wp_username}:${wpAppPassword}`).toString('base64');
  }

  async ztteam_uploadMedia(
    wpUrl: string,
    authHeader: string,
    buffer: Buffer,
    filename: string,
    mimeType: string
  ): Promise<{ id: number; source_url: string }> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${wpUrl}/wp-json/wp/v2/media`, buffer, {
          headers: {
            Authorization: authHeader,
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Type': mimeType
          }
        })
      );
      return {
        id: response.data.id,
        source_url: response.data.source_url
      };
    } catch (error: any) {
      this.logger.error(`Failed to upload media to WordPress at ${wpUrl}/wp-json/wp/v2/media`, error.response?.data || error.message);
      throw error;
    }
  }

  async ztteam_deleteMedia(
    wpUrl: string,
    authHeader: string,
    mediaId: number
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.httpService.delete(`${wpUrl}/wp-json/wp/v2/media/${mediaId}?force=true`, {
          headers: { Authorization: authHeader }
        })
      );
      this.logger.log(`Successfully deleted media #${mediaId} on WP`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Failed to delete media #${mediaId} on WP: ${err.message}`);
      return false;
    }
  }

  async ztteam_updatePostFeaturedMedia(
    wpUrl: string,
    authHeader: string,
    postId: string | number,
    featuredMediaId: number
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.httpService.post(
          `${wpUrl}/wp-json/wp/v2/posts/${postId}`,
          { featured_media: featuredMediaId },
          {
            headers: {
              Authorization: authHeader,
              'Content-Type': 'application/json'
            }
          }
        )
      );
      this.logger.log(`Successfully updated WP post #${postId} with featured_media #${featuredMediaId}`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Failed to update WP post #${postId} featured_media: ${err.message}`);
      return false;
    }
  }

  async ztteam_deletePost(
    wpUrl: string,
    authHeader: string,
    postId: string | number
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.httpService.delete(`${wpUrl}/wp-json/wp/v2/posts/${postId}?force=true`, {
          headers: { Authorization: authHeader }
        })
      );
      this.logger.log(`Successfully deleted WP post #${postId}`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Failed to delete WP post #${postId}: ${err.message}`);
      return false;
    }
  }

  async ztteam_createPost(siteId: string, data: { title: string; content: string; excerpt?: string; categories?: number[]; tags?: number[]; imageUrl?: string | null }) {
    const site = await this.prisma.ztteam_target_sites.findUnique({
      where: { id: siteId }
    });

    if (!site) {
      throw new HttpException('Target site not found', HttpStatus.NOT_FOUND);
    }

    const wpAppPassword = this.ztteam_decrypt(site.wp_app_password_encrypted);
    const authHeader = 'Basic ' + Buffer.from(`${site.wp_username}:${wpAppPassword}`).toString('base64');
    const cleanUrl = site.wp_url.replace(/\/$/, '');

    /** Clean HTML and Upload Images */
    let cleanContent = data.content;
    try {
      cleanContent = await this.htmlCleaner.ztteam_cleanHtmlAndUploadImages(
        data.content,
        async (buffer, filename, mimeType) => {
          const res = await this.ztteam_uploadMedia(cleanUrl, authHeader, buffer, filename, mimeType);
          return res.source_url;
        }
      );
    } catch (err: any) {
      this.logger.warn(`Failed to clean HTML or upload images: ${err.message}`);
      /** Fallback to original content if cleaner completely fails */
    }

    try {
      const payload: any = {
        title: data.title,
        content: cleanContent,
        status: 'publish',
      };
      if (data.excerpt) payload.excerpt = data.excerpt;
      if (data.categories && data.categories.length > 0) payload.categories = data.categories;
      if (data.tags && data.tags.length > 0) payload.tags = data.tags;

      /** Handle featured image (thumbnail) */
      if (data.imageUrl) {
        try {
          let buffer: Buffer;
          const ext = data.imageUrl.split('.').pop()?.split('?')[0] || 'png';

          if (data.imageUrl.startsWith('http://') || data.imageUrl.startsWith('https://')) {
            /** Download the image via HTTP */
            const imageRes = await firstValueFrom(
              this.httpService.get(data.imageUrl, {
                responseType: 'arraybuffer',
                timeout: 20000,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
              })
            );
            buffer = Buffer.from(imageRes.data);
          } else {
            /** Read local image file from storage */
            let localFile: string;
            if (data.imageUrl.startsWith('/storage') || data.imageUrl.startsWith('storage')) {
              localFile = path.join(ztteam_getStorageRoot(), data.imageUrl.replace(/^\/?storage[/\\]?/, ''));
            } else if (fs.existsSync(data.imageUrl)) {
              localFile = data.imageUrl;
            } else {
              localFile = path.join(ztteam_getStorageRoot(), data.imageUrl.replace(/^[/\\]+/, ''));
            }
            if (!fs.existsSync(localFile)) {
              throw new Error(`Local image file not found: ${localFile}`);
            }
            buffer = fs.readFileSync(localFile);
          }

          const mimeType = ext.toLowerCase() === 'png' ? 'image/png' : ext.toLowerCase() === 'webp' ? 'image/webp' : 'image/jpeg';

          /** Upload to WP and set featured_media */
          const media = await this.ztteam_uploadMedia(cleanUrl, authHeader, buffer, `thumbnail_${Date.now()}.${ext}`, mimeType);
          if (media && media.id) {
            payload.featured_media = media.id;
            this.logger.log(`Successfully uploaded featured media to WP: Media ID ${media.id}`);
          }
        } catch (mediaErr: any) {
          this.logger.warn(`Failed to upload featured image for post: ${mediaErr.message}`);
        }
      }

      /** 1. Check if post with same title already exists */
      const searchResponse = await firstValueFrom(
        this.httpService.get(`${cleanUrl}/wp-json/wp/v2/posts`, {
          headers: { Authorization: authHeader },
          params: { search: data.title, status: 'any' }
        })
      );

      const existingPost = searchResponse.data.find((p: any) => p.title.rendered === data.title || p.title.raw === data.title);

      let response;
      if (existingPost) {
        /** Update existing post */
        response = await firstValueFrom(
          this.httpService.post(
            `${cleanUrl}/wp-json/wp/v2/posts/${existingPost.id}`,
            payload,
            {
              headers: {
                Authorization: authHeader,
                'Content-Type': 'application/json'
              },
            }
          )
        );
      } else {
        /** Create new post */
        response = await firstValueFrom(
          this.httpService.post(
            `${cleanUrl}/wp-json/wp/v2/posts`,
            payload,
            {
              headers: {
                Authorization: authHeader,
                'Content-Type': 'application/json'
              },
            }
          )
        );
      }

      return {
        id: response.data.id,
        url: response.data.link
      };
    } catch (error: any) {
      this.logger.error(`Failed to create post on WordPress at ${cleanUrl}/wp-json/wp/v2/posts`, error.response?.data || error.message);
      throw new HttpException(
        error.response?.data?.message || 'Failed to create post on WordPress',
        HttpStatus.BAD_REQUEST
      );
    }
  }

  async ztteam_getCategories(siteId: string, userId: string) {
    let site = await this.prisma.ztteam_target_sites.findFirst({
      where: { id: siteId, owner_user_id: userId }
    });
    if (!site) {
      site = await this.prisma.ztteam_target_sites.findUnique({ where: { id: siteId } });
    }

    if (!site) throw new HttpException('Website WordPress không tồn tại trong hệ thống', HttpStatus.NOT_FOUND);

    const appPassword = this.ztteam_decrypt(site.wp_app_password_encrypted);
    const authHeader = 'Basic ' + Buffer.from(`${site.wp_username}:${appPassword}`).toString('base64');
    let wpUrl = site.wp_url.replace(/\/$/, '');

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${wpUrl}/wp-json/wp/v2/categories`, {
          headers: { Authorization: authHeader },
          params: { per_page: 100 },
          timeout: 10000,
        })
      );

      return response.data.map((cat: any) => ({
        id: cat.id,
        name: cat.name,
        count: cat.count
      }));
    } catch (error: any) {
      this.logger.error('Failed to fetch categories from WordPress', error.response?.data || error.message);
      throw new HttpException('Lỗi khi lấy danh sách chuyên mục từ WordPress: ' + (error.response?.data?.message || error.message), HttpStatus.BAD_REQUEST);
    }
  }

  async ztteam_getTags(siteId: string, userId: string) {
    let site = await this.prisma.ztteam_target_sites.findFirst({
      where: { id: siteId, owner_user_id: userId }
    });
    if (!site) {
      site = await this.prisma.ztteam_target_sites.findUnique({ where: { id: siteId } });
    }

    if (!site) throw new HttpException('Website WordPress không tồn tại trong hệ thống', HttpStatus.NOT_FOUND);

    const appPassword = this.ztteam_decrypt(site.wp_app_password_encrypted);
    const authHeader = 'Basic ' + Buffer.from(`${site.wp_username}:${appPassword}`).toString('base64');
    let wpUrl = site.wp_url.replace(/\/$/, '');

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${wpUrl}/wp-json/wp/v2/tags`, {
          headers: { Authorization: authHeader },
          params: { per_page: 100 },
          timeout: 10000,
        })
      );

      return response.data.map((tag: any) => ({
        id: tag.id,
        name: tag.name,
        count: tag.count
      }));
    } catch (error: any) {
      this.logger.error('Failed to fetch tags from WordPress', error.response?.data || error.message);
      throw new HttpException('Lỗi khi lấy danh sách tag từ WordPress: ' + (error.response?.data?.message || error.message), HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * ZTTeam: Chuẩn hóa tiêu đề bài viết để so khớp chống trùng lặp tuyệt đối
   * Giải mã toàn bộ HTML entities (&rsquo;, &#8217;, &amp;...) và chuẩn hóa chữ thường
   */
  ztteam_normalizeTitle(title: string): string {
    if (!title) return '';
    return title
      .toLowerCase()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#8217;/g, "'")
      .replace(/&#8216;/g, "'")
      .replace(/&#8220;/g, '"')
      .replace(/&#8221;/g, '"')
      .replace(/&#8211;/g, '-')
      .replace(/&#8212;/g, '--')
      .replace(/&hellip;/g, '...')
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]*>?/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * ZTTeam: Tự động dọn dẹp các bài trùng lặp chưa đăng trước khi đồng bộ mới
   */
  async ztteam_autoCleanupDuplicatesBeforeSync(): Promise<number> {
    let removedCount = 0;
    try {
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
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(`Auto cleanup duplicates before sync: ${e.message}`);
    }
    return removedCount;
  }

  async ztteam_getPosts(
    siteId: string,
    userId: string,
    categoryId?: string,
    targetTags?: string,
    page: number = 1,
    perPage: number = 20
  ) {
    let site = await this.prisma.ztteam_target_sites.findFirst({
      where: { id: siteId, owner_user_id: userId }
    });
    if (!site) {
      site = await this.prisma.ztteam_target_sites.findUnique({ where: { id: siteId } });
    }

    if (!site) throw new HttpException('Website WordPress không tồn tại trong hệ thống', HttpStatus.NOT_FOUND);

    const appPassword = this.ztteam_decrypt(site.wp_app_password_encrypted);
    const authHeader = 'Basic ' + Buffer.from(`${site.wp_username}:${appPassword}`).toString('base64');
    let wpUrl = site.wp_url.replace(/\/$/, '');

    try {
      const params: any = { per_page: perPage, _embed: 1 };
      if (page > 1) params.page = page;
      if (categoryId) params.categories = categoryId;
      if (targetTags) params.tags = targetTags;

      const response = await firstValueFrom(
        this.httpService.get(`${wpUrl}/wp-json/wp/v2/posts`, {
          headers: { Authorization: authHeader },
          params,
          timeout: 15000,
        })
      );

      return response.data.map((p: any) => {
        const rawTitle = p.title?.rendered || 'No Title';
        const cleanTitle = this.ztteam_normalizeTitle(rawTitle);
        // Giữ title hiển thị đẹp nhưng đã decode HTML entities
        const displayTitle = rawTitle
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .replace(/&#8217;/g, "'")
          .replace(/&#8216;/g, "'")
          .replace(/&#8220;/g, '"')
          .replace(/&#8221;/g, '"')
          .replace(/&#8211;/g, '-')
          .replace(/&#8212;/g, '--')
          .replace(/&hellip;/g, '...')
          .replace(/&nbsp;/g, ' ')
          .replace(/<[^>]*>?/gm, '')
          .trim();

        const rawContent = p.content?.rendered || p.title?.rendered || '';
        const cleanContent = rawContent.replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').trim();
        const rawExcerpt = p.excerpt?.rendered || cleanContent.substring(0, 180);
        const cleanExcerpt = rawExcerpt.replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').trim();

        /** Extract image URL */
        let imageUrl: string | null = null;
        if (p._embedded?.['wp:featuredmedia']?.[0]?.source_url) {
          imageUrl = p._embedded['wp:featuredmedia'][0].source_url;
        } else {
          const imgMatch = p.content?.rendered?.match(/<img[^>]+(?:src|data-src)="([^"]+)"/i);
          if (imgMatch) imageUrl = imgMatch[1];
        }

        return {
          id: p.id,
          title: displayTitle,
          cleanTitle: cleanTitle,
          date: p.date,
          link: p.link,
          content: cleanContent,
          excerpt: cleanExcerpt,
          imageUrl: imageUrl,
        };
      });
    } catch (e: any) {
      this.logger.error('Failed to get posts from WP', e.response?.data || e.message);
      throw new HttpException(
        'Không thể kết nối đến WordPress: ' + (e.response?.data?.message || e.message),
        HttpStatus.BAD_REQUEST
      );
    }
  }

  async ztteam_getSamplePost(siteId: string, userId: string, categoryId?: string, targetTags?: string) {
    let site = await this.prisma.ztteam_target_sites.findFirst({
      where: { id: siteId, owner_user_id: userId }
    });
    if (!site) {
      site = await this.prisma.ztteam_target_sites.findUnique({ where: { id: siteId } });
    }

    if (!site) throw new HttpException('Website WordPress không tồn tại trong hệ thống', HttpStatus.NOT_FOUND);

    const appPassword = this.ztteam_decrypt(site.wp_app_password_encrypted);
    const authHeader = 'Basic ' + Buffer.from(`${site.wp_username}:${appPassword}`).toString('base64');
    let wpUrl = site.wp_url.replace(/\/$/, '');

    try {
      const params: any = { per_page: 1, _fields: 'id,title,content' };
      if (categoryId) params.categories = categoryId;
      if (targetTags) params.tags = targetTags;

      const response = await firstValueFrom(
        this.httpService.get(`${wpUrl}/wp-json/wp/v2/posts`, {
          headers: { Authorization: authHeader },
          params,
          timeout: 10000,
        })
      );

      if (response.data && response.data.length > 0) {
        const post = response.data[0];
        /** Strip HTML from content */
        const rawContent = post.content?.rendered || post.title?.rendered || '';
        const cleanContent = rawContent.replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').trim();
        return {
          id: post.id,
          title: post.title?.rendered,
          content: cleanContent
        };
      }
      return null;
    } catch (e: any) {
      this.logger.error('Failed to get sample post from WP', e.response?.data || e.message);
      return null;
    }
  }

  /**
   * ZTTeam: Tải ảnh chuẩn, định dạng nội dung và nhập 1 bài viết độc quyền vào Fanpage
   */
  async ztteam_importPostToPage(page: any, site: any, post: any): Promise<boolean> {
    const newImageId = crypto.randomUUID();
    const targetDir = ztteam_getImagesPath(newImageId);
    fs.mkdirSync(targetDir, { recursive: true });

    let localImageUrl = '';
    if (post.imageUrl) {
      try {
        let imgUrl = post.imageUrl;
        if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
        else if (imgUrl.startsWith('/')) imgUrl = site.wp_url.replace(/\/$/, '') + imgUrl;

        const imgRes = await axios.get(imgUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': site.wp_url,
          }
        });

        const buf = Buffer.from(imgRes.data);
        const outPath = path.join(targetDir, 'output.png');
        const origPath = path.join(targetDir, 'source_original.png');

        try {
          await sharp(buf).png().toFile(outPath);
        } catch {
          fs.writeFileSync(outPath, buf);
        }
        fs.writeFileSync(origPath, buf);

        localImageUrl = `/storage/images/${newImageId}/output.png`;
      } catch (dlErr: any) {
        this.logger.warn(`Không thể tải ảnh chuẩn từ WP (${post.imageUrl}): ${dlErr.message}`);
      }
    }

    if (!localImageUrl) {
      this.logger.warn(`Bài viết #${post.id} ("${post.title}") không có ảnh đại diện khả dụng, bỏ qua để đảm bảo chất lượng video.`);
      return false;
    }

    const titleUpper = (post.title || '').trim().toUpperCase();
    const rawExcerpt = post.excerpt || post.content || '';
    const cleanSnippet = rawExcerpt.substring(0, 500).trim();
    let fanpageCaption = `${titleUpper}\n\n${cleanSnippet}\n\n${ZTTEAM_NEWS_CAPTION_CTA}`;
    if (page.add_link_to_caption) {
      fanpageCaption += `\n\nFull story: ${post.link}`;
    }
    const firstCommentText = ztteam_getNewsComment(post.link);
    const shouldRenderVideo = page.post_format === 'reel' || page.post_format === 'mixed';

    const imgRecord = await this.prisma.ztteam_images.create({
      data: {
        id: newImageId,
        page_id: page.id,
        wp_post_id: post.id.toString(),
        wp_post_title: post.title || 'Bài viết',
        wp_post_url: post.link,
        template_id: 'wp_standard_image',
        image_url: localImageUrl,
        ai_caption: fanpageCaption,
        ai_first_comment: firstCommentText,
        comment_step: 0,
        status: 'COMPLETED',
        video_status: shouldRenderVideo ? 'PENDING' : 'NONE',
        video_engine: page.video_engine || 'hook_image',
      }
    });

    await this.prisma.ztteam_image_history.upsert({
      where: {
        page_id_wp_post_id: {
          page_id: page.id,
          wp_post_id: post.id.toString(),
        }
      },
      create: {
        page_id: page.id,
        wp_post_id: post.id.toString(),
      },
      update: {},
    });

    this.eventEmitter.emit('image.updated', imgRecord);

    if (shouldRenderVideo) {
      this.hookVideoService.ztteam_renderHookVideo(newImageId).catch(err => {
        this.logger.error(`Render video thất bại cho bài ${newImageId}: ${err.message}`);
      });
    }

    this.logger.log(`[WP Auto-Sync] Đã đồng bộ thành công bài "${post.title}" (ID: ${post.id}) vào Fanpage "${page.name}"`);
    return true;
  }

  /**
   * ZTTeam: Tự động đồng bộ bài viết có sẵn từ Website WordPress vào Fanpage để Render Video
   * TUYỆT ĐỐI không gọi SangTao.ai, sử dụng trực tiếp ảnh chuẩn đã có sẵn của bài viết trên WordPress
   */
  async ztteam_syncPostsForPage(
    pageId: string,
    options?: { maxBatch?: number; forceSync?: boolean; userId?: string }
  ): Promise<{ success: boolean; count: number; message: string }> {
    const page = await this.prisma.ztteam_pages.findUnique({
      where: { id: pageId },
      include: { sources: true, fb_account: true }
    });

    if (!page || !page.is_active) {
      return { success: false, count: 0, message: 'Fanpage không tồn tại hoặc đang bị tắt' };
    }

    const activeSources = page.sources.filter(s => s.is_active && s.target_site_id);
    if (activeSources.length === 0) {
      return { success: false, count: 0, message: 'Fanpage chưa được liên kết với Website WordPress nào (Vui lòng chọn nguồn trong Cài đặt Fanpage)' };
    }

    const batchSize = options?.maxBatch || page.auto_scan_batch_size || 3;
    const maxAgeDays = page.auto_max_post_age_days || 30;
    const queueLimit = page.auto_queue_limit || 10;
    const now = new Date();

    /** Kiểm tra số lượng bài đang chờ xuất bản trong hàng đợi của Fanpage này */
    const currentQueueCount = await this.prisma.ztteam_images.count({
      where: {
        page_id: page.id,
        is_posted: false,
      }
    });

    if (currentQueueCount >= queueLimit && !options?.forceSync) {
      this.logger.log(`Hàng đợi của Fanpage "${page.name}" đã đạt giới hạn (${currentQueueCount}/${queueLimit}). Bỏ qua lượt quét này.`);
      return { success: true, count: 0, message: `Hàng đợi đã đạt giới hạn (${currentQueueCount}/${queueLimit} bài). Vui lòng đợi các bài cũ xuất bản.` };
    }

    let totalSynced = 0;

    for (const source of activeSources) {
      if (totalSynced >= batchSize) break;

      const site = await this.prisma.ztteam_target_sites.findUnique({
        where: { id: source.target_site_id }
      });
      if (!site || site.status !== 'active') continue;

      try {
        const ownerUserId = options?.userId || page.fb_account?.owner_user_id || site.owner_user_id;
        const posts = await this.ztteam_getPosts(
          source.target_site_id,
          ownerUserId,
          source.target_category_id || undefined,
          source.target_tags || undefined
        );

        if (!posts || posts.length === 0) continue;

        /** Sắp xếp bài cũ xuất bản trước (FIFO) */
        const reversedPosts = [...posts].reverse();

        for (const post of reversedPosts) {
          if (totalSynced >= batchSize) break;
          if (currentQueueCount + totalSynced >= queueLimit && !options?.forceSync) break;

          /** 1. KIỂM TRA ĐỘC QUYỀN TOÀN CỤC: Tuyệt đối không cho phép 2 Fanpage lấy trùng cùng 1 bài viết */
          const postWpIdStr = post.id.toString();
          const postTitleTrimmed = (post.title || '').trim();

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
          if (alreadyInImagesGlobally) {
            continue;
          }

          const alreadyInHistoryGlobally = await this.prisma.ztteam_image_history.findFirst({
            where: { wp_post_id: postWpIdStr },
            select: { id: true, page_id: true }
          });
          if (alreadyInHistoryGlobally) {
            continue;
          }

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
          if (alreadyInReelsGlobally) {
            continue;
          }

          const alreadyInReelHistoryGlobally = await this.prisma.ztteam_reel_history.findFirst({
            where: { wp_post_id: postWpIdStr },
            select: { id: true, page_id: true }
          });
          if (alreadyInReelHistoryGlobally) {
            continue;
          }

          /** 2. Kiểm tra tuổi của bài viết */
          if (maxAgeDays > 0 && post.date) {
            const postDate = new Date(post.date);
            const diffDays = Math.ceil(Math.abs(now.getTime() - postDate.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays > maxAgeDays && !options?.forceSync) {
              continue;
            }
          }

          /** 3. Nhập bài viết độc quyền cho Fanpage */
          const imported = await this.ztteam_importPostToPage(page, site, post);
          if (imported) {
            totalSynced++;
          }
        }
      } catch (siteErr: any) {
        this.logger.error(`Lỗi quét bài từ website ${site.wp_url} cho Fanpage ${page.name}: ${siteErr.message}`);
      }
    }

    /** Cập nhật thời điểm quét mới nhất của Fanpage */
    await this.prisma.ztteam_pages.update({
      where: { id: page.id },
      data: { last_auto_scan_at: new Date() }
    });

    return {
      success: true,
      count: totalSynced,
      message: totalSynced > 0
        ? `Đã đồng bộ thành công ${totalSynced} bài viết từ Website vào hàng đợi Fanpage!`
        : 'Không tìm thấy bài viết mới nào cần đồng bộ.'
    };
  }

  /**
   * ZTTeam: Quét toàn bộ Fanpage đang bật tính năng Tự động quét bài viết từ Website
   */
  async ztteam_syncAllActivePages(): Promise<number> {
    const pages = await this.prisma.ztteam_pages.findMany({
      where: {
        is_active: true,
        auto_create_enabled: true,
      },
      include: { sources: true },
      orderBy: { last_auto_scan_at: 'asc' },
      take: 50,
    });

    let processedPages = 0;

    for (const page of pages) {
      if (!page.sources || page.sources.length === 0) continue;

      const now = new Date();
      const lastScan = page.last_auto_scan_at ? new Date(page.last_auto_scan_at) : null;
      const intervalHours = page.auto_scan_interval_hours || 2;
      if (lastScan) {
        const hoursSince = (now.getTime() - lastScan.getTime()) / (1000 * 60 * 60);
        if (hoursSince < intervalHours) continue;
      }

      try {
        await this.ztteam_syncPostsForPage(page.id);
        processedPages++;
      } catch (err: any) {
        this.logger.error(`Tự động đồng bộ lỗi cho Fanpage ${page.id}: ${err.message}`);
      }
    }

    return processedPages;
  }

  /**
   * ZTTeam: Đồng bộ bài viết từ 1 Website cụ thể vào Kho Đăng Thủ Công (page_id: null)
   */
  async ztteam_syncPostsForSite(
    siteId: string,
    userId: string,
    options?: { categoryId?: string; targetTags?: string; maxBatch?: number }
  ): Promise<{ success: boolean; count: number; message: string }> {
    const site = await this.prisma.ztteam_target_sites.findFirst({
      where: { id: siteId, owner_user_id: userId }
    }) || await this.prisma.ztteam_target_sites.findUnique({ where: { id: siteId } });

    if (!site) {
      throw new HttpException('Không tìm thấy Website WordPress', HttpStatus.NOT_FOUND);
    }

    const posts = await this.ztteam_getPosts(site.id, userId, options?.categoryId, options?.targetTags);
    if (!posts || posts.length === 0) {
      return { success: true, count: 0, message: 'Website không có bài viết nào trong chuyên mục này' };
    }

    const batchSize = options?.maxBatch || 5;
    let totalSynced = 0;

    for (const post of posts) {
      if (totalSynced >= batchSize) break;

      /** Kiểm tra đã có bài này trong hệ thống chưa (Toàn cục cả images, image_history, reels, reel_history, và title) */
      const sitePostWpIdStr = post.id.toString();
      const sitePostTitleTrimmed = (post.title || '').trim();

      const existingInImages = await this.prisma.ztteam_images.findFirst({
        where: {
          OR: [
            { wp_post_id: sitePostWpIdStr },
            ...(sitePostTitleTrimmed ? [{ wp_post_title: sitePostTitleTrimmed }] : []),
            ...(post.link ? [{ wp_post_url: post.link }] : [])
          ]
        }
      });
      if (existingInImages) continue;

      const existingHistory = await this.prisma.ztteam_image_history.findFirst({
        where: { wp_post_id: sitePostWpIdStr }
      });
      if (existingHistory) continue;

      const existingInReels = await this.prisma.ztteam_reels.findFirst({
        where: {
          OR: [
            { wp_post_id: sitePostWpIdStr },
            ...(sitePostTitleTrimmed ? [{ wp_post_title: sitePostTitleTrimmed }] : []),
            ...(post.link ? [{ wp_post_url: post.link }] : [])
          ]
        }
      });
      if (existingInReels) continue;

      const existingInReelHistory = await this.prisma.ztteam_reel_history.findFirst({
        where: { wp_post_id: sitePostWpIdStr }
      });
      if (existingInReelHistory) continue;

      const newImageId = crypto.randomUUID();
      const targetDir = ztteam_getImagesPath(newImageId);
      fs.mkdirSync(targetDir, { recursive: true });

      let localImageUrl = '';
      if (post.imageUrl) {
        try {
          let imgUrl = post.imageUrl;
          if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
          else if (imgUrl.startsWith('/')) imgUrl = site.wp_url.replace(/\/$/, '') + imgUrl;

          const imgRes = await axios.get(imgUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': site.wp_url,
            }
          });

          const buf = Buffer.from(imgRes.data);
          const outPath = path.join(targetDir, 'output.png');
          const origPath = path.join(targetDir, 'source_original.png');

          try {
            await sharp(buf).png().toFile(outPath);
          } catch {
            fs.writeFileSync(outPath, buf);
          }
          fs.writeFileSync(origPath, buf);

          localImageUrl = `/storage/images/${newImageId}/output.png`;
        } catch (dlErr: any) {
          this.logger.warn(`Không thể tải ảnh từ WP (${post.imageUrl}): ${dlErr.message}`);
        }
      }

      if (!localImageUrl) continue;

      const titleUpper = (post.title || '').trim().toUpperCase();
      const rawExcerpt = post.excerpt || post.content || '';
      const cleanSnippet = rawExcerpt.substring(0, 500).trim();
      const fanpageCaption = `${titleUpper}\n\n${cleanSnippet}\n\n${ZTTEAM_NEWS_CAPTION_CTA}`;
      const firstCommentText = ztteam_getNewsComment(post.link);

      const imgRecord = await this.prisma.ztteam_images.create({
        data: {
          id: newImageId,
          page_id: null, /** Kho Đăng Thủ Công */
          wp_post_id: post.id.toString(),
          wp_post_title: post.title || 'Bài viết',
          wp_post_url: post.link,
          template_id: 'wp_standard_image',
          image_url: localImageUrl,
          ai_caption: fanpageCaption,
          ai_first_comment: firstCommentText,
          comment_step: 0,
          status: 'COMPLETED',
          video_status: 'PENDING',
          video_engine: 'hook_image',
        }
      });

      this.eventEmitter.emit('image.updated', imgRecord);

      this.hookVideoService.ztteam_renderHookVideo(newImageId).catch(err => {
        this.logger.error(`Render video lỗi cho bài studio ${newImageId}: ${err.message}`);
      });

      totalSynced++;
    }

    return {
      success: true,
      count: totalSynced,
      message: `Đã đồng bộ thành công ${totalSynced} bài viết vào Kho Đăng Thủ Công!`
    };
  }

  /**
   * ZTTeam: Đồng bộ bài viết hàng loạt cho nhiều Fanpage hoặc theo Business Manager (BM)
   */
  async ztteam_bulkSyncPages(
    userId: string,
    body: {
      scope?: 'selected' | 'bm' | 'all';
      pageIds?: string[];
      bmName?: string;
      maxBatch?: number;
    }
  ): Promise<{
    success: boolean;
    totalPages: number;
    successfulPages: number;
    totalPostsSynced: number;
    message: string;
  }> {
    const { scope = 'selected', pageIds = [], bmName, maxBatch = 2 } = body;

    const user = await this.prisma.ztteam_users.findUnique({ where: { id: userId } });
    const isAdmin = !user || user.role === 'ADMIN';

    let candidatePages: any[] = [];

    if (scope === 'bm' && bmName) {
      candidatePages = await this.prisma.ztteam_pages.findMany({
        where: {
          is_active: true,
          fb_account: {
            business_name: bmName,
            ...(isAdmin ? {} : { owner_user_id: userId }),
          }
        },
        include: { sources: true }
      });
    } else if (scope === 'all') {
      candidatePages = await this.prisma.ztteam_pages.findMany({
        where: {
          is_active: true,
          ...(isAdmin ? {} : { fb_account: { owner_user_id: userId } }),
        },
        include: { sources: true }
      });
    } else {
      /** scope === 'selected' */
      if (!pageIds || pageIds.length === 0) {
        return {
          success: false,
          totalPages: 0,
          successfulPages: 0,
          totalPostsSynced: 0,
          message: 'Vui lòng chọn ít nhất 1 Fanpage để đồng bộ.'
        };
      }

      candidatePages = await this.prisma.ztteam_pages.findMany({
        where: {
          is_active: true,
          OR: [
            { id: { in: pageIds } },
            { fb_page_id: { in: pageIds } }
          ],
          ...(isAdmin ? {} : { fb_account: { owner_user_id: userId } }),
        },
        include: { sources: true }
      });
    }

    if (candidatePages.length === 0) {
      return {
        success: false,
        totalPages: 0,
        successfulPages: 0,
        totalPostsSynced: 0,
        message: 'Không tìm thấy Fanpage nào phù hợp với phạm vi đã chọn.'
      };
    }

    let totalPostsSynced = 0;
    let successfulPages = 0;
    let skippedNoSourcePages = 0;

    /** 1. Tự động dọn dẹp các bài trùng lặp chưa đăng đang tồn đọng trong database */
    await this.ztteam_autoCleanupDuplicatesBeforeSync();

    /** 2. Gom nhóm các Fanpage ứng viên theo Website WordPress nguồn */
    const siteToPagesMap = new Map<string, { site: any; pages: any[] }>();

    for (const page of candidatePages) {
      const activeSources = (page.sources || []).filter((s: any) => s.is_active && s.target_site_id);
      if (activeSources.length === 0) {
        skippedNoSourcePages++;
        continue;
      }

      for (const src of activeSources) {
        if (!siteToPagesMap.has(src.target_site_id)) {
          const site = await this.prisma.ztteam_target_sites.findUnique({
            where: { id: src.target_site_id }
          });
          if (site && site.status === 'active') {
            siteToPagesMap.set(src.target_site_id, { site, pages: [] });
          }
        }
        const entry = siteToPagesMap.get(src.target_site_id);
        if (entry && !entry.pages.some((p: any) => p.id === page.id)) {
          entry.pages.push(page);
        }
      }
    }

    /** 3. Phân phối tập trung độc quyền (Centralized Disjoint Distribution) cho từng Website */
    for (const [siteId, { site, pages: sitePages }] of siteToPagesMap.entries()) {
      if (!sitePages || sitePages.length === 0) continue;

      // Thu thập toàn bộ ID, Tiêu đề, URL bài viết ĐÃ TỒN TẠI trên toàn hệ thống
      const usedPostIds = new Set<string>();
      const usedTitles = new Set<string>();
      const usedUrls = new Set<string>();

      const allImages = await this.prisma.ztteam_images.findMany({
        select: { wp_post_id: true, wp_post_title: true, wp_post_url: true }
      });
      allImages.forEach(img => {
        if (img.wp_post_id) usedPostIds.add(img.wp_post_id.trim());
        if (img.wp_post_title) usedTitles.add(this.ztteam_normalizeTitle(img.wp_post_title));
        if (img.wp_post_url) usedUrls.add(img.wp_post_url.trim().toLowerCase());
      });

      const allImgHistory = await this.prisma.ztteam_image_history.findMany({
        select: { wp_post_id: true }
      });
      allImgHistory.forEach(h => {
        if (h.wp_post_id) usedPostIds.add(h.wp_post_id.trim());
      });

      const allReels = await this.prisma.ztteam_reels.findMany({
        select: { wp_post_id: true, wp_post_title: true, wp_post_url: true }
      });
      allReels.forEach(r => {
        if (r.wp_post_id) usedPostIds.add(r.wp_post_id.trim());
        if (r.wp_post_title) usedTitles.add(this.ztteam_normalizeTitle(r.wp_post_title));
        if (r.wp_post_url) usedUrls.add(r.wp_post_url.trim().toLowerCase());
      });

      const allReelHistory = await this.prisma.ztteam_reel_history.findMany({
        select: { wp_post_id: true }
      });
      allReelHistory.forEach(rh => {
        if (rh.wp_post_id) usedPostIds.add(rh.wp_post_id.trim());
      });

      // Tổng số bài cần lấy cho tất cả các Page thuộc site này
      const targetBatchPerSitePage = maxBatch || 2;
      const totalPostsNeeded = sitePages.length * targetBatchPerSitePage;

      // Quét kho bài WordPress (phân trang để luôn lấy đủ bài mới 100% chưa ai dùng)
      const availableUnusedPosts: any[] = [];
      let pageNum = 1;
      const maxPagesToFetch = 15; // Quét tối đa 15 trang lưu trữ

      while (availableUnusedPosts.length < totalPostsNeeded && pageNum <= maxPagesToFetch) {
        try {
          const ownerUserId = site.owner_user_id || userId;
          const fetchedPosts = await this.ztteam_getPosts(site.id, ownerUserId, undefined, undefined, pageNum, 50);
          if (!fetchedPosts || fetchedPosts.length === 0) {
            break; // Đã hết bài trên WordPress
          }

          for (const post of fetchedPosts) {
            const idStr = post.id.toString().trim();
            const normTitle = (post as any).cleanTitle || this.ztteam_normalizeTitle(post.title);
            const normUrl = (post.link || '').trim().toLowerCase();

            // Kiểm tra loại trừ bài đã từng dùng
            if (usedPostIds.has(idStr) || (normTitle && usedTitles.has(normTitle)) || (normUrl && usedUrls.has(normUrl))) {
              continue;
            }

            // Bài viết 100% MỚI
            availableUnusedPosts.push(post);
            usedPostIds.add(idStr);
            if (normTitle) usedTitles.add(normTitle);
            if (normUrl) usedUrls.add(normUrl);

            if (availableUnusedPosts.length >= totalPostsNeeded) {
              break;
            }
          }

          pageNum++;
        } catch (fetchErr: any) {
          this.logger.error(`Lỗi quét bài từ WordPress ${site.wp_url} (trang ${pageNum}): ${fetchErr.message}`);
          break;
        }
      }

      this.logger.log(`[Đồng Bộ Độc Quyền] Website ${site.wp_url}: Tìm thấy ${availableUnusedPosts.length} bài mới chưa từng dùng cho ${sitePages.length} Fanpage.`);

      // 4. Chia mảng bài viết riêng biệt (Disjoint Slices) cho từng Fanpage
      // Mỗi bài viết được giao độc quyền cho ĐÚNG 1 Fanpage!
      for (const page of sitePages) {
        const batchForThisPage = maxBatch || page.auto_scan_batch_size || 2;
        const pagePosts = availableUnusedPosts.splice(0, batchForThisPage);

        if (pagePosts.length === 0) {
          continue;
        }

        // 5. ATOMIC PRE-RESERVATION LOCK: Khóa bài tức thì vào ztteam_image_history
        for (const p of pagePosts) {
          await this.prisma.ztteam_image_history.upsert({
            where: {
              page_id_wp_post_id: {
                page_id: page.id,
                wp_post_id: p.id.toString(),
              }
            },
            create: {
              page_id: page.id,
              wp_post_id: p.id.toString(),
            },
            update: {},
          });
        }

        // 6. Nhập bài viết và tải ảnh
        let pageSynced = 0;
        for (const post of pagePosts) {
          try {
            const success = await this.ztteam_importPostToPage(page, site, post);
            if (success) {
              pageSynced++;
              totalPostsSynced++;
            }
          } catch (impErr: any) {
            this.logger.error(`Lỗi nhập bài #${post.id} cho Page ${page.name}: ${impErr.message}`);
          }
        }

        if (pageSynced > 0) {
          successfulPages++;
        }

        await this.prisma.ztteam_pages.update({
          where: { id: page.id },
          data: { last_auto_scan_at: new Date() }
        });
      }
    }

    let summaryMsg = `Đã đồng bộ ${totalPostsSynced} bài viết cho ${successfulPages}/${candidatePages.length} Fanpage!`;
    if (skippedNoSourcePages > 0) {
      summaryMsg += ` (${skippedNoSourcePages} Fanpage chưa cài nguồn Web nên được bỏ qua).`;
    }

    return {
      success: true,
      totalPages: candidatePages.length,
      successfulPages,
      totalPostsSynced,
      message: summaryMsg
    };
  }
}
