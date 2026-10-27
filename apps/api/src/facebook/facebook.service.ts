import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { ZTTeamAIService } from '../ai/ai.service';
import { ZTTeamStoryTestService } from '../story-test/story-test.service';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class ZTTeamFacebookService {
  private readonly logger = new Logger(ZTTeamFacebookService.name);
  private readonly API_VERSION = 'v25.0';

  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
    private readonly aiService: ZTTeamAIService,
    private readonly storyTestService: ZTTeamStoryTestService,
  ) { }

  async ztteam_exchangeLongLivedToken(shortToken: string, userId: string) {
    /** In a real scenario, appId and appSecret should come from DB or .env */
    const appId = process.env.FB_APP_ID || '';
    const appSecret = process.env.FB_APP_SECRET || '';

    try {
      const response = await firstValueFrom(
        this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/oauth/access_token`, {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: appId,
            client_secret: appSecret,
            fb_exchange_token: shortToken,
          }
        })
      );

      const longLivedToken = response.data.access_token;

      /** Get FB user id */
      const meResponse = await firstValueFrom(
        this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/me`, {
          params: { access_token: longLivedToken }
        })
      );

      const fbUserId = meResponse.data.id;
      const fbName = meResponse.data.name;

      /** Kiểm tra nếu tài khoản FB này đã được kết nối bởi một user khác */
      const existingOtherUser = await this.prisma.ztteam_fb_accounts.findFirst({
        where: { fb_user_id: fbUserId, owner_user_id: { not: userId } }
      });
      if (existingOtherUser) {
        /** Kiểm tra xem tài khoản FB cũ này có còn Fanpage nào đang tồn tại không */
        const activePagesCount = await this.prisma.ztteam_pages.count({
          where: { fb_account_id: existingOtherUser.id }
        });
        if (activePagesCount > 0) {
          throw new BadRequestException('Tài khoản Facebook này đã được kết nối bởi người quản trị khác. Vui lòng sử dụng tài khoản Facebook của riêng bạn!');
        } else {
          /** Nếu tài khoản FB cũ đã bị xóa hết Page ➔ Tự động chuyển quyền sở hữu sang userId hiện tại */
          await this.prisma.ztteam_fb_accounts.update({
            where: { id: existingOtherUser.id },
            data: { owner_user_id: userId, user_token_encrypted: longLivedToken, name: fbName }
          });
        }
      }

      /** Upsert FB account in DB */
      let fbAccount = await this.prisma.ztteam_fb_accounts.findFirst({
        where: { fb_user_id: fbUserId, owner_user_id: userId }
      });

      if (fbAccount) {
        fbAccount = await this.prisma.ztteam_fb_accounts.update({
          where: { id: fbAccount.id },
          data: { user_token_encrypted: longLivedToken, name: fbName }
        });
      } else {
        fbAccount = await this.prisma.ztteam_fb_accounts.create({
          data: {
            fb_user_id: fbUserId,
            name: fbName,
            user_token_encrypted: longLivedToken,
            owner_user_id: userId,
          }
        });
      }

      return fbAccount;
    } catch (error) {
      this.logger.error('Error exchanging Facebook token', error);
      throw error;
    }
  }

  async ztteam_fetchPages(fbAccountId: string, userId: string) {
    const fbAccount = await this.prisma.ztteam_fb_accounts.findFirst({
      where: {
        owner_user_id: userId,
        OR: [
          { id: fbAccountId },
          { fb_user_id: fbAccountId },
        ],
      },
    });

    if (!fbAccount) {
      throw new BadRequestException('Không tìm thấy tài khoản Facebook hoặc bạn không có quyền!');
    }

    try {
      /** GET /me/accounts with user long lived token gives page access tokens that do not expire */
      const response = await firstValueFrom(
        this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/me/accounts`, {
          params: {
            access_token: fbAccount.user_token_encrypted,
            fields: 'id,name,picture.type(large),category,followers_count,fan_count,access_token',
            limit: 100
          }
        })
      );
      let pages = Array.isArray(response.data?.data) ? [...response.data.data] : [];

      /**
       * ZTTeam: Fallback nạp Fanpage New Page Experience / Meta Business Suite
       * Khi GET /me/accounts trả về thiếu trang mà người dùng đã cấp quyền,
       * ta quét danh sách target_ids từ Facebook debug_token và truy vấn trực tiếp /{page_id}.
       */
      try {
        const appId = process.env.FB_APP_ID || '';
        const appSecret = process.env.FB_APP_SECRET || '';
        if (appId && appSecret) {
          const debugRes = await firstValueFrom(
            this.httpService.get(`https://graph.facebook.com/debug_token`, {
              params: {
                input_token: fbAccount.user_token_encrypted,
                access_token: `${appId}|${appSecret}`,
              }
            })
          );
          const granularScopes = debugRes.data?.data?.granular_scopes || [];
          const targetIdsSet = new Set<string>();
          for (const gs of granularScopes) {
            if (Array.isArray(gs.target_ids)) {
              for (const tid of gs.target_ids) {
                targetIdsSet.add(tid);
              }
            }
          }

          const existingIds = new Set(pages.map((p: any) => p.id));
          for (const targetId of targetIdsSet) {
            if (!existingIds.has(targetId)) {
              try {
                const singlePageRes = await firstValueFrom(
                  this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/${targetId}`, {
                    params: {
                      access_token: fbAccount.user_token_encrypted,
                      fields: 'id,name,picture.type(large),category,followers_count,fan_count,access_token',
                    }
                  })
                );
                if (singlePageRes.data && singlePageRes.data.access_token) {
                  pages.push(singlePageRes.data);
                  existingIds.add(targetId);
                  this.logger.log(`ZTTeam: Đã nạp thành công Fanpage New Page Experience: ${singlePageRes.data.name} (${targetId})`);
                }
              } catch (singleErr: any) {
                this.logger.warn(`Không thể nạp Fanpage targetId ${targetId}: ${singleErr.response?.data?.error?.message || singleErr.message}`);
              }
            }
          }
        }
      } catch (debugErr: any) {
        this.logger.warn(`Lỗi khi quét target_ids từ debug_token: ${debugErr.message}`);
      }

      /**
       * CHỈ update các trường lấy từ Facebook API (name, avatar, category, token, follower_count).
       * KHÔNG BAO GIỜ ghi đè: default_reel_template_id, auto_create_enabled, schedule_*,
       * ai_tone, ai_caption_length, ai_custom_prompt, voice_speed, tags, sources, v.v.
       */
      for (const page of pages) {
        const pageData: any = {
          name: page.name,
          category: page.category || null,
          page_token_encrypted: page.access_token,
          token_status: 'active',
        };
        
        if (page.id) {
          pageData.avatar = `https://graph.facebook.com/${page.id}/picture?type=large`;
        }

        const fCount1 = Number(page.followers_count) || 0;
        const fCount2 = Number(page.fan_count) || 0;
        let newCount = Math.max(fCount1, fCount2);

        if (newCount === 0 && page.id) {
          const directToken = page.access_token || fbAccount?.user_token_encrypted;
          if (directToken) {
            try {
              const directPageRes = await firstValueFrom(
                this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/${page.id}`, {
                  params: { fields: 'followers_count,fan_count', access_token: directToken }
                })
              );
              if (directPageRes.data) {
                const df1 = Number(directPageRes.data.followers_count) || 0;
                const df2 = Number(directPageRes.data.fan_count) || 0;
                newCount = Math.max(df1, df2);
              }
            } catch (e: any) {
              /** Bỏ qua nếu fallback lỗi */
            }
          }
        }
        pageData.follower_count = newCount;

        const existingPage = await this.prisma.ztteam_pages.findFirst({
          where: {
            fb_page_id: page.id,
          },
          include: {
            fb_account: true
          }
        });

        if (existingPage) {
          /** Nếu Fanpage đã tồn tại và thuộc về tài khoản FB này thì update token */
          if (existingPage.fb_account_id === fbAccount.id) {
            await this.prisma.ztteam_pages.update({
              where: { id: existingPage.id },
              data: pageData,
            });
          } 
          /** Nếu Fanpage thuộc về tài khoản FB khác nhưng CÙNG 1 người dùng Web -> Chuyển giao quyền sở hữu (Nick cũ bị lỗi) */
          else if (existingPage.fb_account?.owner_user_id === fbAccount.owner_user_id) {
            await this.prisma.ztteam_pages.update({
              where: { id: existingPage.id },
              data: {
                ...pageData,
                fb_account_id: fbAccount.id,
              },
            });
            this.logger.log(`Transferred page ${page.name} to new FB account ${fbAccount.name} for user ${fbAccount.owner_user_id}`);
          }
          /** Nếu thuộc về User khác hoàn toàn, ta bỏ qua không tạo mới để tránh trùng lặp. */
        } else {
          await this.prisma.ztteam_pages.create({
            data: {
              ...pageData,
              fb_page_id: page.id,
              fb_account_id: fbAccount.id,
            },
          });
        }
      }

      return this.ztteam_getConnectedPages(fbAccount.owner_user_id);
    } catch (error) {
      this.logger.error('Error fetching Facebook pages', error);
      throw error;
    }
  }

  /**
   * ZTTeam: Kết nối Token Doanh nghiệp (Meta Business System User Token)
   * Tự động nhận diện Business ID, Business Name, App ID, App Name, System User Name
   * và đồng bộ danh sách Fanpage với quyền vĩnh viễn (Never Expire).
   */
  async ztteam_connectBMToken(token: string, userId: string) {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Vui lòng cung cấp mã Token Meta Business hợp lệ');
    }
    const cleanToken = token.trim();

    try {
      /** 1. Gọi debug_token để kiểm tra App ID, Type, Expiry */
      let appId = '';
      let accountType = 'SYSTEM_USER';
      let tokenExpiry = 'NEVER';

      try {
        const debugRes = await firstValueFrom(
          this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/debug_token`, {
            params: { input_token: cleanToken, access_token: cleanToken }
          })
        );
        const d = debugRes.data?.data;
        if (d) {
          appId = d.app_id ? String(d.app_id) : '';
          accountType = d.type === 'SYSTEM_USER' ? 'SYSTEM_USER' : 'PERSONAL';
          tokenExpiry = d.expires_at === 0 ? 'NEVER' : new Date(d.expires_at * 1000).toISOString();
        }
      } catch (dbgErr: any) {
        this.logger.warn(`debug_token warning: ${dbgErr.message}`);
      }

      /** 2. Gọi GET /me để lấy System User ID và Tên */
      const meRes = await firstValueFrom(
        this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/me`, {
          params: { access_token: cleanToken }
        })
      );
      const fbUserId = String(meRes.data.id);
      const fbUserName = meRes.data.name || 'System User';

      /** 3. Gọi GET /me/accounts để lấy danh sách Fanpage và thông tin Business */
      const accountsRes = await firstValueFrom(
        this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/me/accounts`, {
          params: {
            access_token: cleanToken,
            fields: 'id,name,picture.type(large),category,followers_count,fan_count,access_token,business,tasks',
            limit: 100
          }
        })
      );
      const pages = Array.isArray(accountsRes.data?.data) ? accountsRes.data.data : [];

      let businessId: string | null = null;
      let businessName: string | null = null;

      for (const p of pages) {
        if (p.business && p.business.id) {
          businessId = String(p.business.id);
          businessName = p.business.name || 'Doanh Nghiệp Meta';
          break;
        }
      }

      /** 4. Tìm tên Meta App nếu có businessId và appId */
      let appName = 'Meta App';
      if (businessId && appId) {
        try {
          const ownedAppsRes = await firstValueFrom(
            this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/${businessId}/owned_apps`, {
              params: { access_token: cleanToken }
            })
          );
          const ownedApps = ownedAppsRes.data?.data || [];
          const foundApp = ownedApps.find((a: any) => String(a.id) === String(appId));
          if (foundApp && foundApp.name) {
            appName = foundApp.name;
          }
        } catch (appErr: any) {
          this.logger.warn(`Lỗi lấy owned_apps: ${appErr.message}`);
        }
      }

      /** 5. Lưu hoặc cập nhật vào ztteam_fb_accounts */
      let fbAccount = await this.prisma.ztteam_fb_accounts.findFirst({
        where: {
          owner_user_id: userId,
          fb_user_id: fbUserId,
          ...(appId ? { app_id: appId } : {})
        }
      });

      const accountData: any = {
        name: fbUserName,
        account_type: accountType,
        business_id: businessId,
        business_name: businessName,
        app_id: appId,
        app_name: appName,
        token_expiry: tokenExpiry,
        user_token_encrypted: cleanToken,
        status: 'active'
      };

      if (fbAccount) {
        fbAccount = await this.prisma.ztteam_fb_accounts.update({
          where: { id: fbAccount.id },
          data: accountData
        });
      } else {
        fbAccount = await this.prisma.ztteam_fb_accounts.create({
          data: {
            ...accountData,
            fb_user_id: fbUserId,
            owner_user_id: userId
          }
        });
      }

      /** 6. Đồng bộ các Fanpage được cấp quyền cho System User */
      for (const page of pages) {
        const pageData: any = {
          name: page.name,
          category: page.category || null,
          page_token_encrypted: page.access_token || cleanToken,
          token_status: 'active',
          avatar: page.id ? `https://graph.facebook.com/${page.id}/picture?type=large` : null,
          follower_count: Math.max(Number(page.followers_count) || 0, Number(page.fan_count) || 0)
        };

        const existingPage = await this.prisma.ztteam_pages.findFirst({
          where: { fb_page_id: page.id },
          include: { fb_account: true }
        });

        if (existingPage) {
          if (existingPage.fb_account_id === fbAccount.id) {
            await this.prisma.ztteam_pages.update({
              where: { id: existingPage.id },
              data: pageData
            });
          } else if (existingPage.fb_account?.owner_user_id === userId) {
            await this.prisma.ztteam_pages.update({
              where: { id: existingPage.id },
              data: { ...pageData, fb_account_id: fbAccount.id }
            });
          }
        } else {
          await this.prisma.ztteam_pages.create({
            data: {
              ...pageData,
              fb_page_id: page.id,
              fb_account_id: fbAccount.id
            }
          });
        }
      }

      return {
        success: true,
        message: `Đã kết nối thành công Doanh Nghiệp "${businessName || 'Meta BM'}" (App: ${appName}) với ${pages.length} Fanpage!`,
        business: {
          id: businessId,
          name: businessName,
          appId,
          appName,
          systemUserName: fbUserName,
          systemUserId: fbUserId,
          tokenExpiry,
          pagesCount: pages.length
        }
      };
    } catch (error: any) {
      this.logger.error('Error connecting BM Token', error.response?.data || error);
      throw new BadRequestException(error.response?.data?.error?.message || error.message || 'Lỗi kết nối Meta Business Token');
    }
  }

  /**
   * ZTTeam: Lấy danh sách Doanh Nghiệp (BM) kèm cấu trúc tài sản (Apps, System Users, Pages)
   */
  async ztteam_getBusinessesWithAssets(userId: string) {
    const fbAccounts = await this.prisma.ztteam_fb_accounts.findMany({
      where: { owner_user_id: userId },
      include: {
        pages: {
          select: {
            id: true,
            fb_page_id: true,
            name: true,
            avatar: true,
            branding_avatar_url: true,
            category: true,
            follower_count: true,
            is_active: true,
            token_status: true,
            last_checked: true
          },
          orderBy: { name: 'asc' }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    return fbAccounts.map(acc => ({
      id: acc.id,
      fbUserId: acc.fb_user_id,
      accountType: acc.business_id ? (acc.account_type || 'SYSTEM_USER') : 'PERSONAL',
      businessId: acc.business_id,
      businessName: acc.business_name || (acc.business_id ? 'Doanh Nghiệp BM' : 'Tài Khoản Cá Nhân'),
      appId: acc.app_id,
      appName: acc.app_name || (acc.business_id ? 'Meta App' : 'Facebook Login'),
      tokenExpiry: acc.business_id ? (acc.token_expiry || 'NEVER') : 'STANDARD',
      status: acc.status,
      pagesCount: acc.pages.length,
      pages: acc.pages.map(p => ({
        id: p.fb_page_id,
        internalId: p.id,
        name: p.name,
        avatar: (p as any).branding_avatar_url || p.avatar,
        category: p.category,
        followersCount: p.follower_count,
        isActive: p.is_active,
        status: p.token_status,
        lastChecked: p.last_checked
      }))
    }));
  }

  private async ztteam_computePageTimesAndNextVideo(page: any) {
    let lastRenderTime = page.last_auto_scan_at ? page.last_auto_scan_at : null;
    let nextRenderTime = null;
    if (page.auto_create_enabled) {
      if (lastRenderTime) {
        nextRenderTime = new Date(new Date(lastRenderTime).getTime() + page.auto_scan_interval_hours * 3600000);
      } else {
        nextRenderTime = new Date();
      }
    }

    const lastPublishedReel = await this.prisma.ztteam_reels.findFirst({
      where: { page_id: page.id, status: 'POSTED' },
      orderBy: { updated_at: 'desc' }
    });
    
    const lastPublishedImage = await this.prisma.ztteam_images.findFirst({
      where: { page_id: page.id, is_posted: true },
      orderBy: { posted_at: 'desc' }
    });

    let lastPublishTime = lastPublishedReel ? lastPublishedReel.updated_at : null;
    let lastPostTitle = lastPublishedReel?.wp_post_title || lastPublishedReel?.ai_caption || null;
    if (lastPublishedImage?.posted_at && (!lastPublishTime || lastPublishedImage.posted_at > lastPublishTime)) {
      lastPublishTime = lastPublishedImage.posted_at;
      lastPostTitle = lastPublishedImage.wp_post_title || lastPublishedImage.ai_caption || null;
    }
    
    let nextPublishTime = null;

    if (page.auto_publish_enabled === false) {
      nextPublishTime = null;
    } else if (page.schedule_mode === 'immediate') {
      const ztteam_now = new Date();
      if (lastPublishTime) {
        const candidate = new Date(new Date(lastPublishTime).getTime() + page.schedule_immediate_gap_minutes * 60000);
        nextPublishTime = candidate.getTime() > ztteam_now.getTime() ? candidate : ztteam_now;
      } else {
        nextPublishTime = ztteam_now;
      }
    } else if (page.schedule_mode === 'fixed' && page.schedule_fixed_times.length > 0) {
      const ztteam_now = new Date();
      /** ZTTeam: Lấy giờ, phút, ngày theo múi giờ chuẩn Việt Nam (Asia/Ho_Chi_Minh - UTC+7) */
      const ztteam_vnFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });
      const ztteam_parts = ztteam_vnFormatter.formatToParts(ztteam_now);
      const ztteam_vnH = parseInt(ztteam_parts.find(p => p.type === 'hour')?.value || '0', 10);
      const ztteam_vnM = parseInt(ztteam_parts.find(p => p.type === 'minute')?.value || '0', 10);
      const ztteam_vnYear = parseInt(ztteam_parts.find(p => p.type === 'year')?.value || '2026', 10);
      const ztteam_vnMonth = parseInt(ztteam_parts.find(p => p.type === 'month')?.value || '1', 10) - 1;
      const ztteam_vnDay = parseInt(ztteam_parts.find(p => p.type === 'day')?.value || '1', 10);

      const ztteam_currentMinutes = ztteam_vnH * 60 + ztteam_vnM;
      const ztteam_sortedTimes = [...page.schedule_fixed_times].sort();
      let ztteam_foundTime: Date | null = null;

      /** ZTTeam: Tìm khung giờ tiếp theo còn lại trong ngày hôm nay */
      for (const t of ztteam_sortedTimes) {
        const [h, m] = t.split(':').map(Number);
        const tMinutes = h * 60 + m;
        if (tMinutes > ztteam_currentMinutes) {
          ztteam_foundTime = new Date(Date.UTC(ztteam_vnYear, ztteam_vnMonth, ztteam_vnDay, h - 7, m, 0, 0));
          break;
        }
      }

      /** ZTTeam: Nếu tất cả khung giờ hôm nay đã qua, lấy khung giờ đầu tiên của ngày mai */
      if (!ztteam_foundTime && ztteam_sortedTimes.length > 0) {
        const [h, m] = ztteam_sortedTimes[0].split(':').map(Number);
        ztteam_foundTime = new Date(Date.UTC(ztteam_vnYear, ztteam_vnMonth, ztteam_vnDay + 1, h - 7, m, 0, 0));
      }

      nextPublishTime = ztteam_foundTime;
    }

    const nextReelToPublish = await this.prisma.ztteam_reels.findFirst({
      where: { page_id: page.id, status: 'COMPLETED', is_posted: false },
      orderBy: { created_at: 'asc' }
    });

    let templateName = null;
    if (page.default_reel_template_id) {
      const tpl = await this.prisma.ztteam_templates.findUnique({
        where: { id: page.default_reel_template_id },
        select: { name: true }
      });
      templateName = tpl ? tpl.name : null;
    }

    return {
      lastRenderTime,
      nextRenderTime,
      lastPublishTime,
      lastPostTitle,
      nextPublishTime,
      nextVideoTitle: nextReelToPublish ? (nextReelToPublish.wp_post_title || 'Video AI') : null,
      templateName
    };
  }

  async ztteam_getConnectedPages(userId: string) {
    const fbAccounts = await this.prisma.ztteam_fb_accounts.findMany({
      where: { owner_user_id: userId },
      select: { id: true }
    });

    if (fbAccounts.length === 0) return [];

    const accountIds = fbAccounts.map(a => a.id);

    const user = await this.prisma.ztteam_users.findUnique({ where: { id: userId } });
    const isAdmin = !user || user.role === 'ADMIN';

    /** ZTTeam: Nạp danh mục website WordPress để map sang domain hiển thị trên Card Fanpage */
    const targetSites = await this.prisma.ztteam_target_sites.findMany({
      where: isAdmin ? {} : { owner_user_id: userId },
      select: { id: true, wp_url: true }
    });
    const targetSiteMap = new Map<string, string>();
    for (const site of targetSites) {
      targetSiteMap.set(site.id, site.wp_url);
    }

    const pages = await this.prisma.ztteam_pages.findMany({
      where: { fb_account_id: { in: accountIds } },
      include: { fb_account: true, sources: true, youtube_settings: true },
      orderBy: { name: 'asc' }
    });

    /** ZTTeam: Nhận diện các Fanpage đang bị Facebook yêu cầu xác minh danh tính (Subcode 4854002) */
    const checkpointPageIds = new Set<string>();
    pages.forEach(p => {
      if (p.token_status === 'checkpoint_required') {
        checkpointPageIds.add(p.id);
      }
    });

    try {
      const recentFailedPosts = await this.prisma.ztteam_images.findMany({
        where: {
          page_id: { in: pages.map(p => p.id) },
          status: 'FAILED',
          error_log: { contains: '4854002' },
          updated_at: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
        },
        select: { page_id: true }
      });
      recentFailedPosts.forEach(post => {
        if (post.page_id) checkpointPageIds.add(post.page_id);
      });
    } catch (e: any) {
      /** Bỏ qua lỗi phụ */
    }

    const result = await Promise.all(pages.map(async p => {
      const times = await this.ztteam_computePageTimesAndNextVideo(p);

      /** ZTTeam: Đếm số lượng bài viết đang chờ xuất bản trong hàng đợi */
      const pendingImagesCount = await this.prisma.ztteam_images.count({
        where: { page_id: p.id, is_posted: false, status: { in: ['QUEUED', 'RENDERING', 'COMPLETED'] } }
      });
      const pendingReelsCount = await this.prisma.ztteam_reels.count({
        where: { page_id: p.id, is_posted: false, status: { in: ['QUEUED', 'RENDERING', 'COMPLETED'] } }
      });

      const activeSources = (p.sources || []).filter(s => s.is_active);
      const sourceWebs = activeSources.map(s => {
        const fullUrl = targetSiteMap.get(s.target_site_id) || '';
        try {
          return new URL(fullUrl).hostname.replace(/^www\./, '');
        } catch {
          return fullUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        }
      }).filter(Boolean);

      return {
        id: p.fb_page_id,
        internalId: p.id,
        name: p.name,
        category: p.category,
        followersCount: p.follower_count,
        avatar: (p as any).branding_avatar_url || p.avatar,
        accountType: p.fb_account.business_id ? (p.fb_account.account_type || 'SYSTEM_USER') : 'PERSONAL',
        businessId: p.fb_account.business_id,
        businessName: p.fb_account.business_name || (p.fb_account.business_id ? 'Doanh Nghiệp BM' : 'Tài Khoản Cá Nhân'),
        appId: p.fb_account.app_id,
        appName: p.fb_account.app_name || (p.fb_account.business_id ? 'Meta App' : 'Facebook Login'),
        tokenExpiry: p.fb_account.business_id ? (p.fb_account.token_expiry || 'NEVER') : 'STANDARD',
        status: p.token_status,
        isActive: p.is_active,
        tags: p.tags,
        postFormat: p.post_format,
        scheduleMode: p.schedule_mode,
        autoPublishEnabled: p.auto_publish_enabled,
        autoCreateEnabled: p.auto_create_enabled,
        addLinkToCaption: p.add_link_to_caption,
        addLinkToComment: p.add_link_to_comment,
        nextPublishTime: times.nextPublishTime,
        nextRenderTime: times.nextRenderTime,
        scheduleFixedTimes: p.schedule_fixed_times,
        scheduleImmediateGapMinutes: p.schedule_immediate_gap_minutes,
        autoScanIntervalHours: p.auto_scan_interval_hours,
        defaultReelTemplateId: p.default_reel_template_id,
        defaultReelTemplateName: times.templateName,
        nextVideoTitle: times.nextVideoTitle,
        sourcesCount: activeSources.length,
        sourceWebs,
        primarySourceWeb: sourceWebs[0] || null,
        sources: activeSources.map(s => ({
          id: s.id,
          target_site_id: s.target_site_id,
          target_category_id: s.target_category_id,
          target_tags: s.target_tags,
          is_active: s.is_active,
          siteUrl: targetSiteMap.get(s.target_site_id) || '',
        })),
        lastPublishTime: times.lastPublishTime,
        lastPostTitle: times.lastPostTitle,
        pendingImagesCount,
        pendingReelsCount,
        totalPendingCount: pendingImagesCount + pendingReelsCount,
        isCheckpointBlocked: checkpointPageIds.has(p.id),
        /** We do not send accessToken back to frontend for security */
      };
    }));
    return result;
  }


  async ztteam_getPageSettings(pageId: string, userId: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: {
        OR: [
          { fb_page_id: pageId },
          { id: pageId }
        ]
      },
      include: {
        fb_account: true,
        sources: true,
        youtube_settings: true
      }
    });

    if (!page || page.fb_account.owner_user_id !== userId) {
      throw new Error('Fanpage không tồn tại hoặc bạn không có quyền');
    }

    const times = await this.ztteam_computePageTimesAndNextVideo(page);

    let isCheckpointBlocked = page.token_status === 'checkpoint_required';
    if (!isCheckpointBlocked) {
      try {
        const recentFailed = await this.prisma.ztteam_images.findFirst({
          where: {
            page_id: page.id,
            status: 'FAILED',
            error_log: { contains: '4854002' },
            updated_at: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
          },
          select: { id: true }
        });
        if (recentFailed) isCheckpointBlocked = true;
      } catch (e: any) {
        /** Bỏ qua lỗi phụ */
      }
    }

    return {
      id: page.id,
      fb_page_id: page.fb_page_id,
      name: page.name,
      avatar: page.avatar,
      isCheckpointBlocked,
      tags: page.tags,
      cover_url: (page as any).cover_url || null,
      branding: {
        avatarUrl: (page as any).branding_avatar_url || page.avatar || null,
        avatarPrompt: (page as any).branding_avatar_prompt || null,
        coverUrl: (page as any).branding_cover_url || (page as any).cover_url || null,
        coverPrompt: (page as any).branding_cover_prompt || null,
      },
      post_format: page.post_format,
      video_engine: (page as any).video_engine || 'hook_image',
      default_bgm: (page as any).default_bgm || null,
      auto_publish_enabled: page.auto_publish_enabled,
      add_link_to_caption: page.add_link_to_caption,
      add_link_to_comment: page.add_link_to_comment,
      link_mode: (page as any).link_mode || 'instant',
      link_view_threshold: (page as any).link_view_threshold !== undefined ? (page as any).link_view_threshold : 1000,
      link_target_placement: (page as any).link_target_placement || 'comment',
      link_fallback_after_hours: (page as any).link_fallback_after_hours !== undefined ? (page as any).link_fallback_after_hours : 12,
      schedule_mode: page.schedule_mode,
      schedule_fixed_times: page.schedule_fixed_times,
      schedule_immediate_gap_minutes: page.schedule_immediate_gap_minutes,
      default_reel_template_id: page.default_reel_template_id,
      default_image_template_id: page.default_image_template_id,
      auto_create_enabled: page.auto_create_enabled,
      auto_scan_interval_hours: page.auto_scan_interval_hours,
      auto_scan_batch_size: page.auto_scan_batch_size,
      auto_queue_limit: page.auto_queue_limit,
      auto_max_post_age_days: page.auto_max_post_age_days,
      ai_tone: page.ai_tone,
      ai_caption_length: page.ai_caption_length,
      ai_custom_prompt: page.ai_custom_prompt,
      voice_speed: page.voice_speed,
      last_render_time: times.lastRenderTime,
      next_render_time: times.nextRenderTime,
      last_publish_time: times.lastPublishTime,
      next_publish_time: times.nextPublishTime,
      next_video_title: times.nextVideoTitle,
      sources: page.sources.map(s => ({
        id: s.id,
        target_site_id: s.target_site_id,
        target_category_id: s.target_category_id,
        target_tags: s.target_tags,
        is_active: s.is_active
      })),
      youtube_settings: page.youtube_settings ? {
        source_id: page.youtube_settings.source_id,
        is_active: page.youtube_settings.is_active,
        add_watermark: page.youtube_settings.add_watermark,
        watermark_text: page.youtube_settings.watermark_text,
        add_frame: page.youtube_settings.add_frame
      } : null
    };
  }

  async ztteam_updatePageSettings(pageId: string, userId: string, config: any) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: {
        OR: [
          { fb_page_id: pageId },
          { id: pageId }
        ]
      },
      include: { fb_account: true }
    });

    if (!page || page.fb_account.owner_user_id !== userId) {
      throw new Error('Fanpage không tồn tại hoặc bạn không có quyền');
    }

    /** Update main page fields */
    const updateData: any = {
      tags: config.tags,
      post_format: config.post_format,
      video_engine: config.video_engine || 'hook_image',
      default_bgm: config.default_bgm !== undefined ? config.default_bgm : null,
      auto_publish_enabled: config.auto_publish_enabled !== undefined ? config.auto_publish_enabled : true,
      add_link_to_caption: config.add_link_to_caption,
      add_link_to_comment: config.add_link_to_comment,
      link_mode: config.link_mode !== undefined ? config.link_mode : 'instant',
      link_view_threshold: config.link_view_threshold !== undefined ? Number(config.link_view_threshold) : 1000,
      link_target_placement: config.link_target_placement || 'comment',
      link_fallback_after_hours: config.link_fallback_after_hours !== undefined ? Number(config.link_fallback_after_hours) : 12,
      schedule_mode: config.schedule_mode,
      schedule_fixed_times: config.schedule_fixed_times,
      schedule_immediate_gap_minutes: config.schedule_immediate_gap_minutes,
      default_reel_template_id: config.default_reel_template_id,
      default_image_template_id: config.default_image_template_id,
      auto_create_enabled: config.auto_create_enabled,
      auto_scan_interval_hours: config.auto_scan_interval_hours,
      auto_scan_batch_size: config.auto_scan_batch_size,
      auto_queue_limit: config.auto_queue_limit,
      auto_max_post_age_days: config.auto_max_post_age_days,
      ai_tone: config.ai_tone,
      ai_caption_length: config.ai_caption_length,
      ai_custom_prompt: config.ai_custom_prompt,
      voice_speed: config.voice_speed,
    };

    /** ZTTeam: Nếu người dùng bật lại tự động đăng, khôi phục token_status về active để xóa cảnh báo */
    if (config.auto_publish_enabled === true && page.token_status === 'checkpoint_required') {
      updateData.token_status = 'active';
    }

    await this.prisma.ztteam_pages.update({
      where: { id: page.id },
      data: updateData
    });

    /** Handle sources */
    if (config.sources && Array.isArray(config.sources)) {
      /** Delete old sources */
      await this.prisma.ztteam_page_sources.deleteMany({
        where: { page_id: page.id }
      });
      /** Add new sources */
      if (config.sources.length > 0) {
        await this.prisma.ztteam_page_sources.createMany({
          data: config.sources.map((s: any) => ({
            page_id: page.id,
            target_site_id: s.target_site_id,
            target_category_id: s.target_category_id !== null && s.target_category_id !== undefined ? String(s.target_category_id) : null,
            target_tags: s.target_tags !== null && s.target_tags !== undefined ? String(s.target_tags) : null,
            is_active: s.is_active !== undefined ? Boolean(s.is_active) : true
          }))
        });
      }
    }

    /** Handle youtube_settings */
    if (config.youtube_settings) {
      await this.prisma.ztteam_page_youtube_settings.deleteMany({
        where: { page_id: page.id }
      });
      if (config.youtube_settings.source_id) {
        await this.prisma.ztteam_page_youtube_settings.create({
          data: {
            page_id: page.id,
            source_id: config.youtube_settings.source_id,
            is_active: config.youtube_settings.is_active !== undefined ? config.youtube_settings.is_active : true,
            add_watermark: config.youtube_settings.add_watermark || false,
            watermark_text: config.youtube_settings.watermark_text || null,
            add_frame: config.youtube_settings.add_frame || false
          }
        });
      }
    }

    return { success: true };
  }

  /**
   * ZTTeam: Gán Nguồn Cào Hàng Loạt cho nhiều Fanpage cùng lúc
   */
  async ztteam_bulkAssignSources(userId: string, data: {
    pageIds: string[];
    targetSiteId: string;
    targetCategoryId?: string | null;
    mode?: 'replace' | 'append';
  }) {
    const { pageIds, targetSiteId, targetCategoryId, mode = 'replace' } = data;
    if (!pageIds || pageIds.length === 0) {
      throw new BadRequestException('Vui lòng chọn ít nhất 1 Fanpage để gán nguồn');
    }
    if (!targetSiteId) {
      throw new BadRequestException('Vui lòng chọn Website WordPress đích');
    }

    /** Kiểm tra quyền sở hữu các Page (chấp nhận cả Database UUID lẫn Facebook Page ID) */
    const pages = await this.prisma.ztteam_pages.findMany({
      where: {
        OR: [
          { id: { in: pageIds } },
          { fb_page_id: { in: pageIds } }
        ],
        fb_account: { owner_user_id: userId }
      }
    });

    if (pages.length === 0) {
      throw new BadRequestException('Không tìm thấy Fanpage hợp lệ');
    }

    let affectedCount = 0;
    for (const page of pages) {
      if (mode === 'replace') {
        await this.prisma.ztteam_page_sources.deleteMany({
          where: { page_id: page.id }
        });
      }

      /** Kiểm tra nếu đã có source này chưa */
      const existing = await this.prisma.ztteam_page_sources.findFirst({
        where: {
          page_id: page.id,
          target_site_id: targetSiteId,
          target_category_id: targetCategoryId ? String(targetCategoryId) : null
        }
      });

      if (!existing) {
        await this.prisma.ztteam_page_sources.create({
          data: {
            page_id: page.id,
            target_site_id: targetSiteId,
            target_category_id: targetCategoryId ? String(targetCategoryId) : null,
            is_active: true
          }
        });
      }
      affectedCount++;
    }

    return {
      success: true,
      count: affectedCount,
      message: `Đã gán nguồn cào thành công cho ${affectedCount} Fanpage!`
    };
  }

  /**
   * ZTTeam: Áp dụng Lịch Đăng & Kiểu Tạo Video Hàng Loạt (Rải lệch 2 phút từng Page)
   */
  async ztteam_bulkApplySchedule(
    userId: string,
    data: {
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
    }
  ) {
    const {
      pageIds,
      postsPerDay = 4,
      customTimes,
      postFormat,
      videoEngine,
      defaultBgm,
      autoPublishEnabled,
      linkMode,
      linkViewThreshold,
      linkTargetPlacement,
      linkFallbackAfterHours
    } = data;

    if (!pageIds || pageIds.length === 0) {
      throw new BadRequestException('Vui lòng chọn ít nhất 1 Fanpage');
    }

    const pages = await this.prisma.ztteam_pages.findMany({
      where: {
        OR: [
          { id: { in: pageIds } },
          { fb_page_id: { in: pageIds } }
        ],
        fb_account: { owner_user_id: userId }
      },
      orderBy: { name: 'asc' }
    });

    if (pages.length === 0) {
      throw new BadRequestException('Không tìm thấy Fanpage hợp lệ');
    }

    /** Xác định danh sách khung giờ vàng gốc theo số lượng bài/ngày */
    let BASE_GOLDEN_TIMES: string[] = [];
    if (customTimes && Array.isArray(customTimes) && customTimes.length > 0) {
      BASE_GOLDEN_TIMES = customTimes;
    } else {
      switch (Number(postsPerDay)) {
        case 2:
          BASE_GOLDEN_TIMES = ['11:30', '20:00'];
          break;
        case 3:
          BASE_GOLDEN_TIMES = ['08:00', '13:00', '19:30'];
          break;
        case 5:
          BASE_GOLDEN_TIMES = ['05:00', '09:30', '13:30', '17:30', '21:00'];
          break;
        case 6:
          BASE_GOLDEN_TIMES = ['05:00', '08:30', '11:30', '14:30', '17:30', '20:30'];
          break;
        case 4:
        default:
          BASE_GOLDEN_TIMES = ['05:00', '11:30', '16:30', '20:00'];
          break;
      }
    }

    /** Hàm cộng dồn số phút vào mốc giờ chuẩn */
    const addMinutesToTime = (baseTime: string, addMins: number): string => {
      const [h, m] = baseTime.split(':').map(Number);
      const total = h * 60 + m + addMins;
      const newH = Math.floor(total / 60) % 24;
      const newM = total % 60;
      return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
    };

    const results: any[] = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      /** Mỗi page lệch nhau đúng 2 phút (Page 0: +0p, Page 1: +2p, Page 2: +4p,...) */
      const offsetMinutes = i * 2;
      const staggeredTimes = BASE_GOLDEN_TIMES.map(t => addMinutesToTime(t, offsetMinutes));

      const updateData: any = {
        schedule_mode: 'fixed',
        schedule_fixed_times: staggeredTimes,
        auto_publish_enabled: autoPublishEnabled !== undefined ? autoPublishEnabled : true
      };

      if (postFormat) {
        updateData.post_format = postFormat;
      }
      if (videoEngine) {
        updateData.video_engine = videoEngine;
      }
      if (defaultBgm !== undefined) {
        updateData.default_bgm = defaultBgm || null;
      }
      if (linkMode) {
        updateData.link_mode = linkMode;
      }
      if (linkViewThreshold !== undefined) {
        updateData.link_view_threshold = Number(linkViewThreshold);
      }
      if (linkTargetPlacement) {
        updateData.link_target_placement = linkTargetPlacement;
      }
      if (linkFallbackAfterHours !== undefined) {
        updateData.link_fallback_after_hours = Number(linkFallbackAfterHours);
      }

      await this.prisma.ztteam_pages.update({
        where: { id: page.id },
        data: updateData
      });

      results.push({
        pageId: page.id,
        pageName: page.name,
        slotIndex: i + 1,
        offsetMinutes,
        times: staggeredTimes,
        postFormat: updateData.post_format || page.post_format,
        videoEngine: updateData.video_engine || page.video_engine
      });
    }

    return {
      success: true,
      count: pages.length,
      message: `Đã áp dụng cài đặt ${BASE_GOLDEN_TIMES.length} bài/ngày (lệch 2 phút/page) và cấu hình video thành công cho ${pages.length} Fanpage!`,
      details: results
    };
  }


  async ztteam_testPost(pageId: string, userId: string, message: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { fb_page_id: pageId },
      include: { fb_account: true }
    });

    if (!page) {
      throw new Error('Fanpage không tồn tại trong hệ thống');
    }
    if (page.fb_account.owner_user_id !== userId) {
      throw new Error('Bạn không có quyền thao tác trên Fanpage này');
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://graph.facebook.com/${this.API_VERSION}/${pageId}/feed`,
          { message },
          { params: { access_token: page.page_token_encrypted } }
        )
      );

      await this.prisma.ztteam_pages.update({
        where: { id: page.id },
        data: { token_status: 'active' }
      }).catch(() => {});

      return { success: true, postId: response.data.id };
    } catch (error: any) {
      this.logger.error('Error posting to Facebook', error.response?.data || error);
      throw new Error(error.response?.data?.error?.message || 'Lỗi kết nối đến Facebook API');
    }
  }

  async ztteam_getPageInsights(pageId: string, userId?: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { OR: [{ id: pageId }, { fb_page_id: pageId }] },
      include: { fb_account: true }
    });

    if (!page) {
      throw new Error('Fanpage không tồn tại');
    }

    const realFbPageId = page.fb_page_id;

    try {
      const metrics = ['page_media_view', 'page_total_media_view_unique', 'page_views_total', 'page_post_engagements', 'page_daily_follows', 'page_fans'];
      const results = [];

      for (const metric of metrics) {
        try {
          const res = await firstValueFrom(
            this.httpService.get(
              `https://graph.facebook.com/${this.API_VERSION}/${realFbPageId}/insights`,
              {
                params: { metric, period: 'day', date_preset: 'last_28d', access_token: page.page_token_encrypted }
              }
            )
          );
          if (res.data?.data?.length > 0) {
            results.push(res.data.data[0]);
          }
        } catch (e: any) {
          this.logger.warn(`Failed metric ${metric}:`, e.response?.data?.error?.message);
        }
      }

      return results;
    } catch (error: any) {
      this.logger.warn('Error fetching Facebook insights, returning empty data.', error.response?.data || error.message);
      /** Fallback: return mock/empty data so frontend doesn't break */
      return [];
    }
  }

  /**
   * ZTTeam: Lấy tổng số lượt xem video thực tế từ API Facebook /{pageId}/videos
   */
  async ztteam_getPageVideoViews(pageId: string): Promise<number> {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { OR: [{ id: pageId }, { fb_page_id: pageId }] },
    });

    if (!page || !page.page_token_encrypted) {
      return 0;
    }

    try {
      const res = await firstValueFrom(
        this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/${page.fb_page_id}/videos`, {
          params: {
            fields: 'id,views',
            limit: 100,
            access_token: page.page_token_encrypted,
          },
        })
      );
      const videos = res.data?.data || [];
      return videos.reduce((sum: number, v: any) => sum + (Number(v.views) || 0), 0);
    } catch (e: any) {
      this.logger.warn(`Lỗi lấy video views cho Fanpage ${page.name}: ${e.message}`);
      return 0;
    }
  }

  async ztteam_getTopPosts(pageId: string, userId: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { OR: [{ id: pageId }, { fb_page_id: pageId }] },
      include: { fb_account: true }
    });

    if (!page) {
      throw new Error('Fanpage không tồn tại');
    }

    /** Kiểm tra quyền: ADMIN được quyền truy cập mọi Fanpage */
    const caller = userId ? await this.prisma.ztteam_users.findUnique({
      where: { id: userId },
      select: { role: true }
    }) : null;
    const isAdmin = caller?.role === 'ADMIN';

    if (!isAdmin && page.fb_account?.owner_user_id !== userId) {
      throw new Error('Fanpage không tồn tại hoặc bạn không có quyền');
    }

    const realFbPageId = page.fb_page_id;

    try {
      let response;
      try {
        response = await firstValueFrom(
          this.httpService.get(
            `https://graph.facebook.com/${this.API_VERSION}/${realFbPageId}/published_posts`,
            {
              params: {
                fields: 'id,message,created_time,full_picture,attachments{media_type,target,type,url},reactions.summary(true),comments.summary(true),shares',
                limit: 50,
                access_token: page.page_token_encrypted
              }
            }
          )
        );
      } catch (fallbackErr: any) {
        this.logger.warn(`Fallback fetching top posts without engagement:`, fallbackErr.response?.data?.error?.message);
        response = await firstValueFrom(
          this.httpService.get(
            `https://graph.facebook.com/${this.API_VERSION}/${realFbPageId}/published_posts`,
            {
              params: {
                fields: 'id,message,created_time,full_picture,attachments{media_type,target,type,url}',
                limit: 50,
                access_token: page.page_token_encrypted
              }
            }
          )
        );
      }

      /** Lấy danh sách videos từ Facebook để có con số lượt xem (video views) chuẩn xác */
      let videoViewsMap: Record<string, number> = {};
      try {
        const videoRes = await firstValueFrom(
          this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/${realFbPageId}/videos`, {
            params: {
              fields: 'id,views',
              limit: 25,
              access_token: page.page_token_encrypted
            }
          })
        );
        if (videoRes.data?.data) {
          for (const v of videoRes.data.data) {
            if (v.id) videoViewsMap[v.id] = v.views || 0;
          }
        }
      } catch (e: any) {
        /** Ignore video fetch error */
      }

      /** Lấy post_clicks song song cho từng bài để xử lý siêu tốc */
      const rawPosts = (response.data?.data || []).slice(0, 25);
      const posts = await Promise.all(rawPosts.map(async (post: any) => {
        let reactionsCount = post.reactions?.summary?.total_count || 0;
        let commentsCount = post.comments?.summary?.total_count || 0;
        let sharesCount = post.shares?.count || 0;

        let clicks = 0;
        let photoViews = 0;
        let mediaViews = 0;
        let mediaViewsUnique = 0;
        let insightsVideoViews = 0;

        try {
          const insightRes = await firstValueFrom(
            this.httpService.get(
              `https://graph.facebook.com/${this.API_VERSION}/${post.id}/insights`,
              {
                params: {
                  metric: 'post_media_view,post_total_media_view_unique,post_video_views,post_clicks,post_clicks_by_type,post_activity_by_action_type',
                  access_token: page.page_token_encrypted
                }
              }
            )
          );
          const data = insightRes.data?.data || [];
          for (const item of data) {
            if (item.name === 'post_clicks') {
              clicks = Math.max(clicks, item.values?.[0]?.value || 0);
            }
            if (item.name === 'post_clicks_by_type') {
              const types = item.values?.[0]?.value || {};
              photoViews = Math.max(photoViews, types['photo view'] || 0);
            }
            if (item.name === 'post_media_view') {
              mediaViews = Math.max(mediaViews, item.values?.[0]?.value || 0);
            }
            if (item.name === 'post_total_media_view_unique') {
              mediaViewsUnique = Math.max(mediaViewsUnique, item.values?.[0]?.value || 0);
            }
            if (item.name === 'post_video_views') {
              insightsVideoViews = Math.max(insightsVideoViews, item.values?.[0]?.value || 0);
            }
            if (item.name === 'post_activity_by_action_type') {
              const types = item.values?.[0]?.value || {};
              if (reactionsCount === 0 && types['like']) reactionsCount = types['like'];
              if (commentsCount === 0 && types['comment']) commentsCount = types['comment'];
              if (sharesCount === 0 && types['share']) sharesCount = types['share'];
            }
          }
        } catch (e: any) {
          /** Ignore insight error */
        }

        /** Lượt xem video/reel chuẩn từ node video: kiểm tra qua target.id của attachments hoặc fallback post.id */
        let videoViews = 0;
        const targetVideoId = post.attachments?.data?.[0]?.target?.id;
        if (targetVideoId && videoViewsMap[targetVideoId] !== undefined) {
          videoViews = videoViewsMap[targetVideoId];
        } else {
          for (const vId in videoViewsMap) {
            if (post.id && post.id.includes(vId)) {
              videoViews = videoViewsMap[vId];
              break;
            }
          }
        }

        const videoUrl = post.attachments?.data?.[0]?.target?.url || post.attachments?.data?.[0]?.url || '';

        /** Tổng tương tác chuẩn Meta DOC: Cảm xúc + Lượt nhấp + Bình luận + Chia sẻ */
        const engagements = reactionsCount + clicks + commentsCount + sharesCount;

        /** Lượt xem (Impressions): Sử dụng post_media_view (nếu có), nếu video thì kết hợp videoViews */
        let views = Math.max(mediaViews, videoViews, insightsVideoViews, photoViews, clicks);

        /** Người xem (Reach): Sử dụng post_total_media_view_unique (nếu có) */
        let reach = mediaViewsUnique > 0 ? mediaViewsUnique : views;

        /** Lượt hiển thị (Impressions): Bằng số views đối với API hiện tại */
        let impressions = views;

        /** Đảm bảo không bao giờ bị 0 nếu bài viết có tương tác */
        if (views === 0 && engagements > 0) views = engagements;
        if (reach === 0 && engagements > 0) reach = engagements;
        if (impressions === 0 && engagements > 0) impressions = engagements;

        return {
          id: post.id,
          message: post.message || '',
          created_time: post.created_time,
          full_picture: post.full_picture || null,
          views: views,
          reach: reach,
          clicks: clicks,
          impressions: impressions,
          reactions: reactionsCount,
          comments: commentsCount,
          shares: sharesCount,
          engagements,
          videoUrl
        };
      }));

      /** Sắp xếp ưu tiên theo lượt xem giảm dần, nếu bằng nhau thì theo tương tác */
      posts.sort((a, b) => (b.views || 0) - (a.views || 0) || (b.engagements || 0) - (a.engagements || 0));

      /** Lấy URL bài gốc để hiển thị trên frontend */
      try {
        const postIdsToSearch = posts.flatMap(p => p.id.includes('_') ? [p.id, p.id.split('_')[1]] : [p.id]);
        
        const [reels, images] = await Promise.all([
          this.prisma.ztteam_reels.findMany({
            where: { fb_post_id: { in: postIdsToSearch }, wp_post_url: { not: null } },
            select: { fb_post_id: true, wp_post_url: true }
          }),
          this.prisma.ztteam_images.findMany({
            where: { fb_post_id: { in: postIdsToSearch }, wp_post_url: { not: null } },
            select: { fb_post_id: true, wp_post_url: true }
          })
        ]);

        const urlMap = new Map<string, string>();
        for (const r of reels) if (r.fb_post_id && r.wp_post_url) urlMap.set(r.fb_post_id, r.wp_post_url);
        for (const i of images) if (i.fb_post_id && i.wp_post_url) urlMap.set(i.fb_post_id, i.wp_post_url);

        for (const p of posts) {
          const shortId = p.id.includes('_') ? p.id.split('_')[1] : p.id;
          p.wp_post_url = urlMap.get(p.id) || urlMap.get(shortId) || null;
        }
      } catch (e: any) {
        this.logger.warn(`Failed to attach wp_post_url: ${e.message}`);
      }

      return posts;
    } catch (error: any) {
      this.logger.warn(`Failed to fetch top posts for page ${pageId}:`, error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Publish a generated Reel to the Fanpage
   */
  async ztteam_publishReel(pageId: string, videoPath: string, description: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { fb_page_id: pageId }
    });

    if (!page || !page.page_token_encrypted) {
      throw new Error('Fanpage không tồn tại hoặc chưa cấu hình token');
    }

    try {
      const FormData = require('form-data');
      const fs = require('fs');
      const form = new FormData();
      form.append('access_token', page.page_token_encrypted);
      form.append('description', description);
      form.append('source', fs.createReadStream(videoPath));

      const response = await firstValueFrom(
        this.httpService.post(
          `https://graph.facebook.com/${this.API_VERSION}/${pageId}/videos`,
          form,
          { headers: form.getHeaders(), maxBodyLength: Infinity }
        )
      );

      return response.data;
    } catch (error: any) {
      this.logger.error('Error publishing reel to Facebook', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Publish a comment to a Facebook post
   */
  /**
   * Publish a generated Photo to the Fanpage
   */
  async ztteam_publishPhoto(pageId: string, imagePath: string, message: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { fb_page_id: pageId }
    });

    if (!page || !page.page_token_encrypted) {
      throw new Error('Fanpage không tồn tại hoặc chưa cấu hình token');
    }

    try {
      const FormData = require('form-data');
      const fs = require('fs');
      const form = new FormData();
      form.append('access_token', page.page_token_encrypted);
      form.append('message', message);
      form.append('source', fs.createReadStream(imagePath));

      const response = await firstValueFrom(
        this.httpService.post(
          `https://graph.facebook.com/${this.API_VERSION}/${pageId}/photos`,
          form,
          { headers: form.getHeaders(), maxBodyLength: Infinity }
        )
      );

      return response.data.id || response.data.post_id;
    } catch (error: any) {
      this.logger.error('Error publishing photo to Facebook', error.response?.data || error.message);
      throw error;
    }
  }

  async ztteam_publishComment(pageId: string, postId: string, message: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { fb_page_id: pageId }
    });

    if (!page || !page.page_token_encrypted) {
      throw new Error('Fanpage không tồn tại hoặc chưa cấu hình token');
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://graph.facebook.com/${this.API_VERSION}/${postId}/comments`,
          { message, access_token: page.page_token_encrypted }
        )
      );
      return response.data;
    } catch (error: any) {
      this.logger.error('Error publishing comment to Facebook', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * ZTTeam: Lấy danh sách bình luận (kèm reply lồng nhau) của 1 Post hoặc 1 Comment qua Graph API
   */
  async ztteam_getComments(pageId: string, objectId: string): Promise<any[]> {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { fb_page_id: pageId }
    });

    if (!page || !page.page_token_encrypted) {
      throw new Error('Fanpage không tồn tại hoặc chưa cấu hình token');
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `https://graph.facebook.com/${this.API_VERSION}/${objectId}/comments`,
          {
            params: {
              access_token: page.page_token_encrypted,
              fields: 'id,from,message,created_time,comments{id,from,message,created_time}',
              limit: 25
            }
          }
        )
      );
      return response.data?.data || [];
    } catch (error: any) {
      this.logger.error(`Error fetching comments for ${objectId}: ${error.response?.data?.error?.message || error.message}`);
      return [];
    }
  }

  /**
   * ZTTeam: Xóa 1 Fanpage:
   * 1. Chỉ xóa các bài ĐÃ ĐĂNG (is_posted = true hoặc status = POSTED).
   * 2. Các bài CHƯA ĐĂNG (is_posted = false) được tự động chia đều (Round-Robin) cho các Fanpage còn lại của User.
   * 3. Đồng bộ lịch sử hình ảnh và video sang Fanpage mới để tránh crawl trùng lặp.
   */
  async ztteam_deletePage(pageId: string, userId: string) {
    const fs = require('fs');
    const { ztteam_getReelsPath, ztteam_getImagesPath } = require('../common/ztteam_storage.util');

    /** Kiểm tra page tồn tại và thuộc quyền user (hỗ trợ cả fb_page_id và id) */
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { 
        OR: [
          { id: pageId },
          { fb_page_id: pageId }
        ]
      },
      include: { fb_account: true },
    });

    if (!page) {
      throw new BadRequestException('Fanpage không tồn tại');
    }

    if (page.fb_account.owner_user_id !== userId) {
      throw new BadRequestException('Bạn không có quyền xóa Fanpage này');
    }

    const internalPageId = page.id;

    /** Lấy danh sách các Fanpage còn lại của người dùng này để phân bổ lại các bài chưa đăng */
    const allRemainingPages = await this.prisma.ztteam_pages.findMany({
      where: {
        id: { not: internalPageId },
        fb_account: {
          owner_user_id: userId,
        },
      },
      orderBy: { id: 'asc' },
    });

    const activeRemainingPages = allRemainingPages.filter(p => p.is_active !== false);
    const targetCandidatePages = activeRemainingPages.length > 0 ? activeRemainingPages : allRemainingPages;

    let deletedPostedImagesCount = 0;
    let redistributedImagesCount = 0;
    let deletedPostedReelsCount = 0;
    let redistributedReelsCount = 0;

    /** 1. XỬ LÝ BÀI ĐĂNG HÌNH ẢNH (ztteam_images) */
    const allImages = await this.prisma.ztteam_images.findMany({
      where: { page_id: internalPageId },
      orderBy: { created_at: 'asc' },
    });

    const postedImages = allImages.filter(img => img.is_posted === true || img.status === 'POSTED');
    const unpostedImages = allImages.filter(img => img.is_posted === false && img.status !== 'POSTED');

    /** 1.1 Xóa file vật lý và record của các bài ĐÃ ĐĂNG */
    for (const image of postedImages) {
      try {
        const imageDir = ztteam_getImagesPath(image.id);
        if (fs.existsSync(imageDir)) {
          fs.rmSync(imageDir, { recursive: true, force: true });
        }
      } catch (e) {
        this.logger.warn(`Error deleting posted image files for ${image.id}`, e);
      }
    }
    if (postedImages.length > 0) {
      await this.prisma.ztteam_images.deleteMany({
        where: { id: { in: postedImages.map(img => img.id) } },
      });
      deletedPostedImagesCount = postedImages.length;
    }

    /** 1.2 Phân bổ đều các bài CHƯA ĐĂNG cho các Fanpage còn lại */
    if (unpostedImages.length > 0) {
      if (targetCandidatePages.length > 0) {
        for (let i = 0; i < unpostedImages.length; i++) {
          const targetPage = targetCandidatePages[i % targetCandidatePages.length];
          const image = unpostedImages[i];

          await this.prisma.ztteam_images.update({
            where: { id: image.id },
            data: { page_id: targetPage.id },
          });

          /** Đồng bộ image_history sang Fanpage mới để tránh crawl trùng lặp */
          await this.prisma.ztteam_image_history.upsert({
            where: { page_id_wp_post_id: { page_id: targetPage.id, wp_post_id: image.wp_post_id } },
            create: { page_id: targetPage.id, wp_post_id: image.wp_post_id },
            update: {},
          });
        }
        redistributedImagesCount = unpostedImages.length;
      } else {
        /** Nếu người dùng không còn bất kỳ Fanpage nào khác, bắt buộc xóa bài chưa đăng */
        for (const image of unpostedImages) {
          try {
            const imageDir = ztteam_getImagesPath(image.id);
            if (fs.existsSync(imageDir)) {
              fs.rmSync(imageDir, { recursive: true, force: true });
            }
          } catch (e) {}
        }
        await this.prisma.ztteam_images.deleteMany({
          where: { id: { in: unpostedImages.map(img => img.id) } },
        });
      }
    }

    /** 2. XỬ LÝ VIDEO REELS (ztteam_reels) */
    const allReels = await this.prisma.ztteam_reels.findMany({
      where: { page_id: internalPageId },
      orderBy: { created_at: 'asc' },
    });

    const postedReels = allReels.filter(reel => reel.is_posted === true);
    const unpostedReels = allReels.filter(reel => reel.is_posted === false);

    /** 2.1 Xóa file vật lý và record của các Reel ĐÃ ĐĂNG */
    for (const reel of postedReels) {
      try {
        const reelDir = ztteam_getReelsPath(reel.id);
        if (fs.existsSync(reelDir)) {
          fs.rmSync(reelDir, { recursive: true, force: true });
        }
      } catch (e) {
        this.logger.warn(`Error deleting posted reel files for ${reel.id}`, e);
      }
    }
    if (postedReels.length > 0) {
      await this.prisma.ztteam_reels.deleteMany({
        where: { id: { in: postedReels.map(r => r.id) } },
      });
      deletedPostedReelsCount = postedReels.length;
    }

    /** 2.2 Phân bổ đều các Reel CHƯA ĐĂNG cho các Fanpage còn lại */
    if (unpostedReels.length > 0) {
      if (targetCandidatePages.length > 0) {
        for (let i = 0; i < unpostedReels.length; i++) {
          const targetPage = targetCandidatePages[i % targetCandidatePages.length];
          const reel = unpostedReels[i];

          await this.prisma.ztteam_reels.update({
            where: { id: reel.id },
            data: { page_id: targetPage.id },
          });

          await this.prisma.ztteam_reel_history.upsert({
            where: { page_id_wp_post_id: { page_id: targetPage.id, wp_post_id: reel.wp_post_id } },
            create: { page_id: targetPage.id, wp_post_id: reel.wp_post_id },
            update: {},
          });
        }
        redistributedReelsCount = unpostedReels.length;
      } else {
        for (const reel of unpostedReels) {
          try {
            const reelDir = ztteam_getReelsPath(reel.id);
            if (fs.existsSync(reelDir)) {
              fs.rmSync(reelDir, { recursive: true, force: true });
            }
          } catch (e) {}
        }
        await this.prisma.ztteam_reels.deleteMany({
          where: { id: { in: unpostedReels.map(r => r.id) } },
        });
      }
    }

    /** 3. Dọn dẹp lịch sử cũ và nguồn WP của Fanpage bị xóa */
    await this.prisma.ztteam_reel_history.deleteMany({ where: { page_id: internalPageId } });
    await this.prisma.ztteam_image_history.deleteMany({ where: { page_id: internalPageId } });
    await this.prisma.ztteam_page_sources.deleteMany({ where: { page_id: internalPageId } });

    /** 4. Xóa bản ghi Page */
    await this.prisma.ztteam_pages.delete({ where: { id: internalPageId } });

    /** 5. Dọn dẹp FB Account nếu không còn Fanpage nào liên kết */
    if (page.fb_account_id) {
      const remainingPages = await this.prisma.ztteam_pages.count({
        where: { fb_account_id: page.fb_account_id }
      });
      if (remainingPages === 0) {
        await this.prisma.ztteam_fb_accounts.delete({ where: { id: page.fb_account_id } }).catch(() => null);
      }
    }

    const summaryParts: string[] = [];
    if (deletedPostedImagesCount > 0 || deletedPostedReelsCount > 0) {
      summaryParts.push(`đã xóa ${deletedPostedImagesCount + deletedPostedReelsCount} bài đã đăng`);
    }
    if (redistributedImagesCount > 0 || redistributedReelsCount > 0) {
      summaryParts.push(`đã chia đều ${redistributedImagesCount + redistributedReelsCount} bài chưa đăng sang ${targetCandidatePages.length} Fanpage còn lại`);
    }

    const finalMessage = summaryParts.length > 0
      ? `Đã xóa Fanpage "${page.name}". Chi tiết: ${summaryParts.join(', ')}.`
      : `Đã xóa Fanpage "${page.name}" thành công`;

    this.logger.log(`ZTTeam deletePage: ${finalMessage}`);
    return {
      success: true,
      message: finalMessage,
      data: {
        deletedPostedImagesCount,
        redistributedImagesCount,
        deletedPostedReelsCount,
        redistributedReelsCount,
        remainingPagesCount: targetCandidatePages.length,
      }
    };
  }

  /**
   * Khắc phục rác dữ liệu: Tìm tất cả Fanpage bị trùng lặp fb_page_id,
   * gộp toàn bộ dữ liệu (Reels, History, Sources) về bản ghi gốc (bản được tạo đầu tiên),
   * sau đó xoá an toàn bản sao để dọn dẹp Database.
   */
  async ztteam_safeMergeDuplicates() {
    this.logger.log('Bắt đầu tiến trình gộp Fanpage trùng lặp (Safe Merge)...');
    
    /** Lấy tất cả Fanpage sắp xếp theo ngày tạo (cũ nhất đứng trước) */
    const pages = await this.prisma.ztteam_pages.findMany({
      orderBy: { fb_page_id: 'asc' } 
      /** Do ztteam_pages không có created_at nên ta ưu tiên id nào xuất hiện trước */
    });
    
    const groups = new Map<string, any[]>();
    for (const p of pages) {
      if (!groups.has(p.fb_page_id)) {
        groups.set(p.fb_page_id, []);
      }
      groups.get(p.fb_page_id)!.push(p);
    }
    
    const results = [];

    for (const [fb_page_id, duplicates] of groups.entries()) {
      if (duplicates.length > 1) {
        /** 
         * Ưu tiên chọn Bản gốc (Original) là trang có cấu hình đầy đủ nhất
         * (Ví dụ: có gắn Nguồn Crawler hoặc có gán Template Mặc định).
         * Tránh việc vô tình lấy trang rỗng của Manager làm gốc.
         */
        duplicates.sort((a, b) => {
          let scoreA = (a.default_reel_template_id ? 1 : 0) + (a.auto_create_enabled ? 1 : 0);
          let scoreB = (b.default_reel_template_id ? 1 : 0) + (b.auto_create_enabled ? 1 : 0);
          return scoreB - scoreA; /** Giảm dần, trang điểm cao nhất lên đầu */
        });

        const original = duplicates[0];
        const dupesToMerge = duplicates.slice(1);
        
        for (const dupe of dupesToMerge) {
          this.logger.log(`Đang gộp bản sao ${dupe.id} vào bản gốc ${original.id} (${original.name})`);
          
          /** 1. Move Reels */
          await this.prisma.ztteam_reels.updateMany({
            where: { page_id: dupe.id },
            data: { page_id: original.id }
          }).catch(() => null);
          
          /** 2. Move Images */
          await this.prisma.ztteam_images.updateMany({
            where: { page_id: dupe.id },
            data: { page_id: original.id }
          }).catch(() => null);
          
          /** 3. Move Page Sources */
          await this.prisma.ztteam_page_sources.updateMany({
            where: { page_id: dupe.id },
            data: { page_id: original.id }
          }).catch(() => null);
          
          /** 4. Move Reel History (Xử lý Unique Constraints) */
          const dupeReelHistory = await this.prisma.ztteam_reel_history.findMany({ where: { page_id: dupe.id } });
          for (const history of dupeReelHistory) {
            try {
              await this.prisma.ztteam_reel_history.update({
                where: { id: history.id },
                data: { page_id: original.id }
              });
            } catch (e) {
              /** Lịch sử này đã tồn tại ở bản gốc, ta có thể xoá bỏ bản sao */
              await this.prisma.ztteam_reel_history.delete({ where: { id: history.id } }).catch(() => null);
            }
          }
          
          /** 5. Move Image History */
          const dupeImageHistory = await this.prisma.ztteam_image_history.findMany({ where: { page_id: dupe.id } });
          for (const history of dupeImageHistory) {
            try {
              await this.prisma.ztteam_image_history.update({
                where: { id: history.id },
                data: { page_id: original.id }
              });
            } catch (e) {
              await this.prisma.ztteam_image_history.delete({ where: { id: history.id } }).catch(() => null);
            }
          }
          
          /** 6. Xoá an toàn bản sao (bây giờ đã trống rỗng) */
          await this.prisma.ztteam_pages.delete({ where: { id: dupe.id } });
          
          results.push(`Đã gộp thành công bản sao ${dupe.id} vào Fanpage gốc ${original.name} (${original.id})`);
        }
      }
    }

    if (results.length === 0) {
      return { message: 'Không phát hiện Fanpage nào bị trùng lặp.' };
    }

    return { 
      message: 'Đã dọn dẹp và gộp thành công các Fanpage trùng lặp!', 
      details: results 
    };
  }

  async ztteam_togglePageActive(pageId: string, userId: string, isActive: boolean) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { fb_page_id: pageId, fb_account: { owner_user_id: userId } }
    });

    if (!page) {
      throw new BadRequestException('Fanpage không tồn tại hoặc bạn không có quyền truy cập');
    }

    const updated = await this.prisma.ztteam_pages.update({
      where: { id: page.id },
      data: { is_active: isActive }
    });

    return {
      success: true,
      message: isActive ? `Đã bật hoạt động cho Fanpage ${page.name}` : `Đã tắt Fanpage ${page.name}`,
      data: { id: updated.fb_page_id, isActive: updated.is_active }
    };
  }

  async ztteam_checkAccountHealth(userId: string, accountId?: string) {
    /** 1. Tự động dọn dẹp các bản ghi Nick FB trùng lặp bị rỗng (0 Fanpage) */
    try {
      const allAccounts = await this.prisma.ztteam_fb_accounts.findMany({
        where: { owner_user_id: userId },
        include: { pages: true }
      });
      
      const accByName = new Map<string, any[]>();
      for (const a of allAccounts) {
        const key = a.fb_user_id || a.name;
        if (!accByName.has(key)) accByName.set(key, []);
        accByName.get(key)!.push(a);
      }

      for (const [key, group] of accByName.entries()) {
        if (group.length > 1) {
          /** Sắp xếp tài khoản có nhiều Fanpage nhất lên đầu */
          group.sort((a, b) => b.pages.length - a.pages.length);
          const primaryAcc = group[0];
          const duplicates = group.slice(1);

          for (const dupe of duplicates) {
            if (dupe.pages.length === 0) {
              /** Xóa an toàn tài khoản rỗng trùng lặp */
              await this.prisma.ztteam_fb_accounts.delete({ where: { id: dupe.id } }).catch(() => null);
            } else {
              /** Chuyển Fanpage sang tài khoản chính rồi xóa tài khoản phụ */
              await this.prisma.ztteam_pages.updateMany({
                where: { fb_account_id: dupe.id },
                data: { fb_account_id: primaryAcc.id }
              }).catch(() => null);
              await this.prisma.ztteam_fb_accounts.delete({ where: { id: dupe.id } }).catch(() => null);
            }
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(`Deduplicate fb accounts failed: ${e.message}`);
    }

    const whereAccount: any = { owner_user_id: userId };
    if (accountId) whereAccount.id = accountId;

    const accounts = await this.prisma.ztteam_fb_accounts.findMany({
      where: whereAccount,
      include: { pages: true }
    });

    const results: any[] = [];
    const sentAccountAlerts = new Set<string>();

    for (const acc of accounts) {
      const activePages = acc.pages.filter(p => p.is_active !== false);
      if (activePages.length === 0) {
        /** Skip checking account token if all pages are manually disabled */
        continue;
      }

      let isAccValid = true;
      let accErrorMsg = '';

      /** 1. Check FB User Token via Graph API */
      try {
        await firstValueFrom(
          this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/me`, {
            params: { access_token: acc.user_token_encrypted }
          })
        );
      } catch (err: any) {
        isAccValid = false;
        accErrorMsg = err.response?.data?.error?.message || err.message || 'Token hết hạn hoặc Nick bị checkpoint/đổi MK';
      }

      /** If User Token is invalid */
      if (!isAccValid) {
        /** Nếu Nick FB có 0 Fanpage ➔ Tự động xóa sạch tài khoản rỗng bị đứt kết nối khỏi DB */
        if (acc.pages.length === 0) {
          await this.prisma.ztteam_fb_accounts.delete({ where: { id: acc.id } }).catch(() => null);
          continue;
        }

        await this.prisma.ztteam_fb_accounts.update({
          where: { id: acc.id },
          data: { status: 'expired' }
        });

        await this.prisma.ztteam_pages.updateMany({
          where: { fb_account_id: acc.id },
          data: { token_status: 'expired' }
        });

        const alertKey = `${acc.fb_user_id || acc.name}`;
        if (!sentAccountAlerts.has(alertKey)) {
          sentAccountAlerts.add(alertKey);

          const affectedPages = activePages.map(p => p.name).join(', ');
          const warnMsg = this.telegramService.ztteam_formatAlert({
            systemName: 'Giám Sát Token Facebook (Graph API)',
            fanpageName: affectedPages,
            step: 'Kiểm tra tính hợp lệ của User Token Facebook',
            rawError: accErrorMsg,
            nextAction: 'Vui lòng đăng nhập lại tài khoản Facebook trên giao diện Web để cấp lại Token mới!',
            memberEmail: acc.name,
          });
          await this.telegramService.ztteam_sendMessage(warnMsg);
        }

        results.push({
          accountId: acc.id,
          accountName: acc.name,
          status: 'expired',
          error: accErrorMsg,
          pages: acc.pages.map(p => ({ pageId: p.fb_page_id, name: p.name, status: 'expired' }))
        });

        continue;
      }

      /** Account token valid */
      await this.prisma.ztteam_fb_accounts.update({
        where: { id: acc.id },
        data: { status: 'active' }
      });

      /** 2. Check each Page Token */
      const pageResults: any[] = [];
      for (const p of acc.pages) {
        if (p.is_active === false) continue;

        let isPageValid = true;
        let pageErrorMsg = '';
        let followerCountFromFb: number | undefined = undefined;

        try {
          const pageRes = await firstValueFrom(
            this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/${p.fb_page_id}`, {
              params: { fields: 'id,name,followers_count,fan_count', access_token: p.page_token_encrypted }
            })
          );
          if (pageRes.data?.followers_count !== undefined || pageRes.data?.fan_count !== undefined) {
            const f1 = Number(pageRes.data.followers_count) || 0;
            const f2 = Number(pageRes.data.fan_count) || 0;
            followerCountFromFb = Math.max(f1, f2);
          }

          /** Thử fallback bằng user token nếu followerCountFromFb vẫn bằng 0 */
          if (followerCountFromFb === 0 && acc.user_token_encrypted) {
            try {
              const userTokenRes = await firstValueFrom(
                this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/${p.fb_page_id}`, {
                  params: { fields: 'followers_count,fan_count', access_token: acc.user_token_encrypted }
                })
              );
              if (userTokenRes.data?.followers_count !== undefined || userTokenRes.data?.fan_count !== undefined) {
                const uf1 = Number(userTokenRes.data.followers_count) || 0;
                const uf2 = Number(userTokenRes.data.fan_count) || 0;
                followerCountFromFb = Math.max(uf1, uf2);
              }
            } catch (uErr: any) {
              /** Bỏ qua nếu user token không đọc được */
            }
          }
        } catch (err: any) {
          /** Thử fallback bằng user_token_encrypted của nick quản lý khi page token lỗi */
          if (acc.user_token_encrypted) {
            try {
              const fbFallbackRes = await firstValueFrom(
                this.httpService.get(`https://graph.facebook.com/${this.API_VERSION}/${p.fb_page_id}`, {
                  params: { fields: 'id,name,followers_count,fan_count', access_token: acc.user_token_encrypted }
                })
              );
              if (fbFallbackRes.data?.followers_count !== undefined || fbFallbackRes.data?.fan_count !== undefined) {
                const f1 = Number(fbFallbackRes.data.followers_count) || 0;
                const f2 = Number(fbFallbackRes.data.fan_count) || 0;
                followerCountFromFb = Math.max(f1, f2);
              }
            } catch (fallbackErr: any) {
              /** Bỏ qua nếu fallback cũng lỗi */
            }
          }
          isPageValid = false;
          pageErrorMsg = err.response?.data?.error?.message || err.message;
        }

        const newStatus = isPageValid ? 'active' : 'expired';
        const pageUpdateData: any = { token_status: newStatus, last_checked: new Date() };
        if (followerCountFromFb !== undefined) {
          pageUpdateData.follower_count = followerCountFromFb;
        }
        await this.prisma.ztteam_pages.update({
          where: { id: p.id },
          data: pageUpdateData
        });

        if (!isPageValid) {
          const warnMsg = this.telegramService.ztteam_formatAlert({
            systemName: 'Giám Sát Token Fanpage',
            fanpageName: p.name,
            step: 'Kiểm tra Page Access Token qua Graph API',
            rawError: pageErrorMsg || 'Token Fanpage hết hạn hoặc bị thu hồi quyền',
            nextAction: 'Vui lòng kết nối lại tài khoản Facebook trên Web để cấp mới Token cho Fanpage!',
            memberEmail: acc.name,
          });
          await this.telegramService.ztteam_sendMessage(warnMsg);
        }

        pageResults.push({
          pageId: p.fb_page_id,
          name: p.name,
          status: newStatus,
          error: pageErrorMsg || null
        });
      }

      results.push({
        accountId: acc.id,
        accountName: acc.name,
        status: 'active',
        pages: pageResults
      });
    }

    return {
      success: true,
      message: 'Đã kiểm tra xong sức khỏe Token tài khoản Facebook và Fanpage',
      data: results
    };
  }

  async ztteam_getConnectedAccounts(userId: string) {
    const accounts = await this.prisma.ztteam_fb_accounts.findMany({
      where: { owner_user_id: userId },
      include: { pages: true },
      orderBy: { created_at: 'desc' }
    });

    return accounts.map(acc => ({
      id: acc.id,
      fbUserId: acc.fb_user_id,
      name: acc.name,
      status: acc.status,
      pagesCount: acc.pages.length,
      pages: acc.pages.map(p => ({ id: p.fb_page_id, name: p.name })),
      createdAt: acc.created_at,
      updatedAt: acc.updated_at
    }));
  }

  async ztteam_deleteAccount(accountId: string, userId: string) {
    const acc = await this.prisma.ztteam_fb_accounts.findFirst({
      where: { id: accountId, owner_user_id: userId }
    });

    if (!acc) {
      throw new BadRequestException('Tài khoản Facebook không tồn tại hoặc bạn không có quyền xóa');
    }

    /** Xóa tuần tự từng Fanpage thuộc tài khoản này để bảo lưu và chia đều bài chưa đăng */
    const pages = await this.prisma.ztteam_pages.findMany({
      where: { fb_account_id: accountId }
    });
    for (const p of pages) {
      try {
        await this.ztteam_deletePage(p.id, userId);
      } catch (e: any) {
        this.logger.warn(`Không thể xóa Fanpage ${p.id} khi xóa account: ${e.message}`);
      }
    }

    await this.prisma.ztteam_fb_accounts.delete({ where: { id: accountId } }).catch(() => null);

    return {
      success: true,
      message: `Đã xóa tài khoản Facebook ${acc.name} thành công!`
    };
  }

  async ztteam_autoCommentLink(pageId: string, fbPostId: string, manualLink?: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: { fb_page_id: pageId }
    });
    if (!page) throw new BadRequestException('Không tìm thấy Fanpage trong hệ thống');

    let trackingLink = '';
    
    /** Handle PAGEID_POSTID format from Facebook */
    const shortId = fbPostId.includes('_') ? fbPostId.split('_')[1] : fbPostId;

    if (manualLink) {
      trackingLink = manualLink;
      const utmCampaign = 'ztteam_auto_manual';
      trackingLink = `${trackingLink}${trackingLink.includes('?') ? '&' : '?'}utm_source=facebook&utm_medium=manual&utm_campaign=${utmCampaign}`;
    } else {
      const reel = await this.prisma.ztteam_reels.findFirst({
        where: { OR: [{ fb_post_id: fbPostId }, { fb_post_id: shortId }] }
      });
      const image = await this.prisma.ztteam_images.findFirst({
        where: { OR: [{ fb_post_id: fbPostId }, { fb_post_id: shortId }] }
      });

      const record = reel || image;
      if (!record) throw new BadRequestException('Bài viết này không được tạo từ hệ thống (Không tìm thấy trên Database)');
      if (!record.wp_post_url) throw new BadRequestException('Bài viết này không có link nguồn (wp_post_url)');

      trackingLink = record.wp_post_url;
      const utmMedium = reel ? 'reel' : 'image';
      const utmCampaign = 'ztteam_auto';
      trackingLink = `${trackingLink}${trackingLink.includes('?') ? '&' : '?'}utm_source=facebook&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}`;
    }

    const prefixes = ['👉 See details here:', '🔗 Original article link:', '👇 Full article link:'];
    const prefixIndex = Math.floor(Math.random() * prefixes.length);
    const message = `${prefixes[prefixIndex]}\n${trackingLink}`;

    try {
      const response = await firstValueFrom(
        this.httpService.post(`https://graph.facebook.com/${this.API_VERSION}/${fbPostId}/comments`, null, {
          params: {
            message: message,
            access_token: page.page_token_encrypted
          }
        })
      );
      return { success: true, message: 'Đã tự động bốc link và thả comment thành công!', id: response.data.id };
    } catch (error: any) {
      throw new BadRequestException(error.response?.data?.error?.message || error.message || 'Lỗi khi comment qua API Facebook');
    }
  }

  /**
   * ZTTeam: Tự động phân tích chủ đề Fanpage và tạo bộ nhận diện Avatar (1:1) & Cover (16:9) bằng AI Sáng Tạo
   */
  async ztteam_generatePageBranding(internalPageId: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: {
        OR: [
          { fb_page_id: internalPageId },
          { id: internalPageId }
        ]
      },
      include: {
        sources: {
          where: { is_active: true }
        }
      }
    });

    if (!page) {
      throw new BadRequestException('Fanpage không tồn tại');
    }

    /** 1. Lấy thông tin nguồn website và các bài viết gần nhất trong kho để nắm bắt chủ đề */
    let connectedSite: string | null = null;
    if (page.sources && page.sources.length > 0 && page.sources[0].target_site_id) {
      const site = await this.prisma.ztteam_target_sites.findUnique({
        where: { id: page.sources[0].target_site_id }
      });
      connectedSite = site?.wp_url || null;
    }

    const recentImages = await this.prisma.ztteam_images.findMany({
      where: { page_id: page.id },
      orderBy: { created_at: 'desc' },
      take: 3,
      select: { wp_post_title: true }
    });
    const recentReels = await this.prisma.ztteam_reels.findMany({
      where: { page_id: page.id },
      orderBy: { created_at: 'desc' },
      take: 3,
      select: { wp_post_title: true }
    });

    const recentTitles = [
      ...recentImages.map(i => i.wp_post_title),
      ...recentReels.map(r => r.wp_post_title)
    ].filter(Boolean).slice(0, 5);

    this.logger.log(`Tạo bộ nhận diện AI cho Page "${page.name}" (Site: ${connectedSite}, Topics: ${recentTitles.length})`);

    /** 2. Sử dụng OpenAI sáng tạo 2 prompt mỹ thuật chuẩn xác cho Avatar và Cover */
    const prompts = await this.aiService.ztteam_generateBrandingPrompts({
      pageName: page.name,
      category: page.category,
      siteUrl: connectedSite,
      tags: page.tags,
      recentTitles
    });

    /** 3. Gọi tạo ảnh Avatar 1:1 */
    this.logger.log(`Đang sinh Avatar 1:1 với prompt: ${prompts.avatarPrompt}`);
    const avatarResult = await this.ztteam_renderImageSmartFallback(prompts.avatarPrompt, '1:1');

    /** ZTTeam: Lưu ngay lập tức Avatar vào Database để nếu bước tạo Cover gặp lỗi thì Avatar vẫn an toàn */
    await this.prisma.ztteam_pages.update({
      where: { id: page.id },
      data: {
        branding_avatar_url: avatarResult.imageUrl,
        branding_avatar_prompt: prompts.avatarPrompt,
      } as any
    });

    /** 4. Gọi tạo ảnh Cover 16:9 */
    this.logger.log(`Đang sinh Cover 16:9 với prompt: ${prompts.coverPrompt}`);
    let coverResult: any = null;
    try {
      coverResult = await this.ztteam_renderImageSmartFallback(prompts.coverPrompt, '16:9');
      await this.prisma.ztteam_pages.update({
        where: { id: page.id },
        data: {
          branding_cover_url: coverResult.imageUrl,
          branding_cover_prompt: prompts.coverPrompt,
        } as any
      });
    } catch (coverErr: any) {
      this.logger.warn(`Lỗi tạo Ảnh bìa Cover cho Page ${page.name}: ${coverErr.message}`);
    }

    /** 5. ZTTeam: Tự động áp dụng ngay Avatar & Ảnh bìa lên Fanpage Facebook qua Meta Graph API */
    let appliedToFacebook = false;
    let applyMessage = '';
    try {
      this.logger.log(`Tự động áp dụng Avatar & Ảnh bìa lên Facebook cho Page "${page.name}"...`);
      const applyRes = await this.ztteam_applyPageBranding(page.id, {
        avatarUrl: avatarResult.imageUrl,
        avatarLocalPath: avatarResult.localPath,
        coverUrl: coverResult?.imageUrl || null,
        coverLocalPath: coverResult?.localPath || null,
      });
      appliedToFacebook = true;
      applyMessage = applyRes?.message || 'Đã áp dụng thành công lên Facebook!';
      this.logger.log(`[Branding Auto-Apply] Thành công: ${applyMessage}`);
    } catch (applyErr: any) {
      applyMessage = `Lỗi áp dụng lên Facebook: ${applyErr?.message || String(applyErr)}`;
      this.logger.warn(`[Branding Auto-Apply] ${applyMessage}`);
    }

    return {
      success: true,
      pageId: page.id,
      fbPageId: page.fb_page_id,
      pageName: page.name,
      avatarUrl: avatarResult.imageUrl,
      avatarLocalPath: avatarResult.localPath,
      avatarPrompt: prompts.avatarPrompt,
      coverUrl: coverResult?.imageUrl || null,
      coverLocalPath: coverResult?.localPath || null,
      coverPrompt: prompts.coverPrompt,
      avatarEngine: avatarResult.engine,
      coverEngine: coverResult?.engine || null,
      appliedToFacebook,
      applyMessage,
    };
  }

  /**
   * ZTTeam: Danh sách Key SangTao.ai dành riêng cho chức năng tạo Avatar & Ảnh bìa Page (cô lập tuyệt đối với ảnh bài viết)
   * Tự động luân chuyển sang Key kế tiếp khi Key hiện tại hết credit hoặc gặp sự cố
   */
  private readonly ZTTEAM_BRANDING_SANGTAO_KEYS = [
    'stai_751dcc6175575dd8cf1f5fc522b62cc2da73e8404f3f527e', /** Key 1: 24 credit */
    'stai_bf5e874c373092f9429faba2f1d5da159fb9d89929620c70', /** Key 2: 100 credit */
  ];

  /**
   * ZTTeam: Tạo ảnh bằng SangTao.ai (Pool Key Branding riêng), tự động chuyển key khi hết credit
   */
  async ztteam_renderImageSmartFallback(prompt: string, aspectRatio: '1:1' | '16:9'): Promise<{
    imageUrl: string;
    localPath: string;
    engine: 'sangtao';
  }> {
    let lastError: any = null;

    for (let i = 0; i < this.ZTTEAM_BRANDING_SANGTAO_KEYS.length; i++) {
      const currentKey = this.ZTTEAM_BRANDING_SANGTAO_KEYS[i];
      const maskedKey = `${currentKey.substring(0, 8)}...${currentKey.substring(currentKey.length - 4)}`;
      this.logger.log(`[Branding] Đang tạo ảnh (${aspectRatio}) bằng SangTao.ai với Key #${i + 1} (${maskedKey})...`);

      try {
        const result = await this.storyTestService.ztteam_renderStoryImage({
          prompt,
          aspectRatio,
          apiKey: currentKey,
        });

        return {
          imageUrl: result.imageUrl,
          localPath: result.localPath,
          engine: 'sangtao',
        };
      } catch (err: any) {
        lastError = err;
        const errMsg = err?.message || String(err);
        this.logger.warn(`[Branding] Key #${i + 1} (${maskedKey}) gặp lỗi: ${errMsg}. Đang kiểm tra chuyển sang key tiếp theo...`);
      }
    }

    throw new BadRequestException(`Tất cả các Key SangTao.ai Branding đều không thể tạo ảnh: ${lastError?.message || 'Lỗi không xác định'}`);
  }

  /**
   * ZTTeam: Tạo lại riêng Avatar (1:1) hoặc Cover (16:9) nếu muốn đổi phương án khác
   */
  async ztteam_regenerateBrandingItem(internalPageId: string, type: 'avatar' | 'cover', prompt?: string) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: {
        OR: [
          { fb_page_id: internalPageId },
          { id: internalPageId }
        ]
      },
      include: {
        sources: {
          where: { is_active: true }
        }
      }
    });

    if (!page) {
      throw new BadRequestException('Fanpage không tồn tại');
    }

    let activePrompt = prompt;
    if (!activePrompt || activePrompt.trim().length === 0) {
      let connectedSite: string | null = null;
      if (page.sources && page.sources.length > 0 && page.sources[0].target_site_id) {
        const site = await this.prisma.ztteam_target_sites.findUnique({
          where: { id: page.sources[0].target_site_id }
        });
        connectedSite = site?.wp_url || null;
      }
      const recentImages = await this.prisma.ztteam_images.findMany({
        where: { page_id: page.id },
        orderBy: { created_at: 'desc' },
        take: 3,
        select: { wp_post_title: true }
      });
      const recentTitles = recentImages.map(i => i.wp_post_title).filter(Boolean);

      const prompts = await this.aiService.ztteam_generateBrandingPrompts({
        pageName: page.name,
        category: page.category,
        siteUrl: connectedSite,
        tags: page.tags,
        recentTitles
      });

      activePrompt = type === 'avatar' ? prompts.avatarPrompt : prompts.coverPrompt;
    }

    const aspectRatio = type === 'avatar' ? '1:1' : '16:9';
    const result = await this.ztteam_renderImageSmartFallback(activePrompt, aspectRatio);

    /** ZTTeam: Cập nhật dữ liệu vừa vẽ lại vào Database */
    if (type === 'avatar') {
      await this.prisma.ztteam_pages.update({
        where: { id: page.id },
        data: {
          branding_avatar_url: result.imageUrl,
          branding_avatar_prompt: activePrompt,
        } as any
      });
    } else {
      await this.prisma.ztteam_pages.update({
        where: { id: page.id },
        data: {
          branding_cover_url: result.imageUrl,
          branding_cover_prompt: activePrompt,
        } as any
      });
    }

    /** ZTTeam: Tự động cập nhật ngay ảnh vừa vẽ lại lên Fanpage Facebook */
    try {
      this.logger.log(`Tự động cập nhật ${type} vừa vẽ lại lên Facebook cho Page "${page.name}"...`);
      if (type === 'avatar') {
        await this.ztteam_applyPageBranding(page.id, {
          avatarUrl: result.imageUrl,
          avatarLocalPath: result.localPath,
        });
      } else {
        await this.ztteam_applyPageBranding(page.id, {
          coverUrl: result.imageUrl,
          coverLocalPath: result.localPath,
        });
      }
      this.logger.log(`Đã cập nhật ${type} lên Facebook thành công cho Page "${page.name}"!`);
    } catch (applyErr: any) {
      this.logger.warn(`Lỗi cập nhật ${type} lên Facebook cho Page "${page.name}": ${applyErr.message}`);
    }

    return {
      success: true,
      type,
      imageUrl: result.imageUrl,
      localPath: result.localPath,
      prompt: activePrompt,
      engine: result.engine
    };
  }

  /**
   * ZTTeam: Gắn Avatar và/hoặc Ảnh bìa lên Fanpage Facebook qua Meta Graph API
   */
  async ztteam_applyPageBranding(internalPageId: string, data: {
    avatarUrl?: string;
    coverUrl?: string;
    avatarLocalPath?: string;
    coverLocalPath?: string;
  }) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: {
        OR: [
          { fb_page_id: internalPageId },
          { id: internalPageId }
        ]
      }
    });

    if (!page || !page.page_token_encrypted) {
      throw new BadRequestException('Fanpage không tồn tại hoặc chưa có Token hợp lệ');
    }

    const FormData = require('form-data');
    const fs = require('fs');
    const path = require('path');
    const { ztteam_getStorageRoot } = require('../common/ztteam_storage.util');

    /** Helper tìm đường dẫn file cục bộ từ URL hoặc localPath */
    const resolveLocalPath = async (rawPath?: string, rawUrl?: string): Promise<string | null> => {
      if (rawPath && fs.existsSync(rawPath)) return rawPath;
      if (rawUrl) {
        /** Nếu URL có dạng http://.../storage/... hoặc /storage/... */
        const storageMatch = rawUrl.match(/\/storage\/(.+)$/);
        if (storageMatch) {
          const candidate = path.join(ztteam_getStorageRoot(), storageMatch[1]);
          if (fs.existsSync(candidate)) return candidate;
        }
        /** Nếu URL từ internet bên ngoài, tải tạm về */
        if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
          try {
            const resp = await fetch(rawUrl);
            if (resp.ok) {
              const buffer = Buffer.from(await resp.arrayBuffer());
              const tempFile = path.join(ztteam_getStorageRoot(), 'branding', `temp_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
              fs.mkdirSync(path.dirname(tempFile), { recursive: true });
              fs.writeFileSync(tempFile, buffer);
              return tempFile;
            }
          } catch (e: any) {
            this.logger.warn(`Không thể tải ảnh tạm từ ${rawUrl}: ${e.message}`);
          }
        }
      }
      return null;
    };

    let updatedAvatar = false;
    let updatedCover = false;

    /** 1. Gắn Avatar nếu có */
    const avatarFilePath = await resolveLocalPath(data.avatarLocalPath, data.avatarUrl);
    if (avatarFilePath) {
      try {
        this.logger.log(`Đang tải ảnh Avatar lên Facebook cho Page ${page.name}...`);
        /** Bước 1a: Upload ảnh đại diện vào photos của Page với published=false để lấy photoId */
        const avatarUploadForm = new FormData();
        avatarUploadForm.append('access_token', page.page_token_encrypted);
        avatarUploadForm.append('published', 'false');
        avatarUploadForm.append('source', fs.createReadStream(avatarFilePath));

        const uploadRes = await firstValueFrom(
          this.httpService.post(
            `https://graph.facebook.com/${this.API_VERSION}/${page.fb_page_id}/photos`,
            avatarUploadForm,
            { headers: avatarUploadForm.getHeaders(), maxBodyLength: Infinity }
          )
        );

        const avatarPhotoId = uploadRes.data?.id;
        if (!avatarPhotoId) {
          throw new Error('Meta không trả về Photo ID của ảnh đại diện');
        }

        /** Bước 1b: Gán photoId làm Profile Picture qua API /{page-id}/picture */
        await firstValueFrom(
          this.httpService.post(
            `https://graph.facebook.com/${this.API_VERSION}/${page.fb_page_id}/picture`,
            null,
            {
              params: {
                photo: avatarPhotoId,
                access_token: page.page_token_encrypted
              }
            }
          )
        );
        updatedAvatar = true;
      } catch (err: any) {
        this.logger.error(`Lỗi cập nhật Avatar trên Facebook: ${err.response?.data?.error?.message || err.message}`);
        throw new BadRequestException(`Lỗi cập nhật Avatar Facebook: ${err.response?.data?.error?.message || err.message}`);
      }
    }

    /** 2. Gắn Ảnh bìa nếu có */
    const coverFilePath = await resolveLocalPath(data.coverLocalPath, data.coverUrl);
    if (coverFilePath) {
      try {
        this.logger.log(`Đang gửi lệnh đổi Ảnh bìa lên Facebook cho Page ${page.name}...`);
        /** Bước 2a: Tải ảnh vào album của Page với cờ published=false để không spam bảng tin */
        const coverUploadForm = new FormData();
        coverUploadForm.append('access_token', page.page_token_encrypted);
        coverUploadForm.append('published', 'false');
        coverUploadForm.append('source', fs.createReadStream(coverFilePath));

        const uploadRes = await firstValueFrom(
          this.httpService.post(
            `https://graph.facebook.com/${this.API_VERSION}/${page.fb_page_id}/photos`,
            coverUploadForm,
            { headers: coverUploadForm.getHeaders(), maxBodyLength: Infinity }
          )
        );

        const photoId = uploadRes.data?.id;
        if (!photoId) {
          throw new Error('Meta không trả về Photo ID của ảnh bìa');
        }

        /** Bước 2b: Gán photoId làm ảnh bìa chính thức */
        await firstValueFrom(
          this.httpService.post(
            `https://graph.facebook.com/${this.API_VERSION}/${page.fb_page_id}`,
            null,
            {
              params: {
                cover: photoId,
                offset_y: 0,
                access_token: page.page_token_encrypted
              }
            }
          )
        );
        updatedCover = true;
      } catch (err: any) {
        this.logger.error(`Lỗi cập nhật Ảnh bìa trên Facebook: ${err.response?.data?.error?.message || err.message}`);
        throw new BadRequestException(`Lỗi cập nhật Ảnh bìa Facebook: ${err.response?.data?.error?.message || err.message}`);
      }
    }

    if (!updatedAvatar && !updatedCover) {
      throw new BadRequestException('Không tìm thấy file ảnh đại diện hoặc ảnh bìa hợp lệ để tải lên Facebook. Vui lòng bấm Tạo Bộ Nhận Diện trước.');
    }

    /** 3. Cập nhật URL Avatar & Cover mới trong cơ sở dữ liệu để Web Tool đồng bộ */
    const updateData: any = {};
    if (updatedAvatar) {
      updateData.avatar = `https://graph.facebook.com/${page.fb_page_id}/picture?type=large&_t=${Date.now()}`;
      if (data.avatarUrl) {
        updateData.branding_avatar_url = data.avatarUrl;
      }
    }
    if (updatedCover) {
      if (data.coverUrl) {
        updateData.cover_url = data.coverUrl;
        updateData.branding_cover_url = data.coverUrl;
      }
    }
    if (Object.keys(updateData).length > 0) {
      await this.prisma.ztteam_pages.update({
        where: { id: page.id },
        data: updateData
      });
    }

    return {
      success: true,
      message: `Đã áp dụng thành công ${[updatedAvatar ? 'Avatar' : null, updatedCover ? 'Ảnh bìa' : null].filter(Boolean).join(' và ')} lên Fanpage "${page.name}"!`,
      newAvatarUrl: `https://graph.facebook.com/${page.fb_page_id}/picture?type=large&_t=${Date.now()}`,
      newCoverUrl: data.coverUrl || null
    };
  }

  /**
   * ZTTeam: Tạo hàng loạt Avatar & Ảnh bìa cho các Fanpage chưa có hoặc cần sinh mới
   */
  async ztteam_batchGenerateBranding(options: {
    limit?: number;
    overwriteExisting?: boolean;
    pageIds?: string[];
  } = {}) {
    const { limit = 68, overwriteExisting = false, pageIds } = options;

    const whereClause: any = { is_active: true };
    if (pageIds && pageIds.length > 0) {
      whereClause.id = { in: pageIds };
    }

    const pages = await this.prisma.ztteam_pages.findMany({
      where: whereClause,
      orderBy: { name: 'asc' },
    });

    this.logger.log(`[Branding Batch] Bắt đầu xử lý hàng loạt cho ${pages.length} Fanpage (Limit: ${limit}, Overwrite: ${overwriteExisting})...`);

    const results: any[] = [];
    let processedCount = 0;

    for (const page of pages) {
      if (processedCount >= limit) {
        this.logger.log(`[Branding Batch] Đã đạt giới hạn số lượng (${limit} page). Dừng tiến trình.`);
        break;
      }

      const hasAvatar = !!(page as any).branding_avatar_url;
      const hasCover = !!(page as any).branding_cover_url;

      if (!overwriteExisting && hasAvatar && hasCover) {
        this.logger.log(`[Branding Batch] Page "${page.name}" đã có đầy đủ Avatar & Cover. Bỏ qua.`);
        results.push({ pageId: page.id, name: page.name, status: 'SKIPPED', message: 'Đã có đủ Avatar & Cover' });
        continue;
      }

      try {
        this.logger.log(`[Branding Batch] [${processedCount + 1}/${limit}] Đang xử lý Page "${page.name}"...`);
        let pageResult: any = null;

        if (overwriteExisting || (!hasAvatar && !hasCover)) {
          /** Tạo cả bộ Avatar và Cover */
          pageResult = await this.ztteam_generatePageBranding(page.id);
        } else if (!hasCover) {
          /** Chỉ thiếu Cover */
          pageResult = await this.ztteam_regenerateBrandingItem(page.id, 'cover');
        } else if (!hasAvatar) {
          /** Chỉ thiếu Avatar */
          pageResult = await this.ztteam_regenerateBrandingItem(page.id, 'avatar');
        }

        results.push({
          pageId: page.id,
          name: page.name,
          status: 'SUCCESS',
          result: pageResult,
        });
        processedCount++;

        /** Nghỉ 3 giây giữa các page để giữ nhịp độ an toàn cho API */
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        this.logger.error(`[Branding Batch] Lỗi xử lý Page "${page.name}": ${errMsg}`);
        results.push({
          pageId: page.id,
          name: page.name,
          status: 'FAILED',
          error: errMsg,
        });

        /** Nếu tất cả key đều hết credit hoặc lỗi toàn bộ, dừng lại an toàn */
        if (errMsg.includes('Tất cả các Key SangTao.ai') || errMsg.includes('credit')) {
          this.logger.warn('[Branding Batch] Đã hết toàn bộ credit trên tất cả các Key SangTao.ai. Dừng tiến trình an toàn.');
          break;
        }
      }
    }

    return {
      success: true,
      totalRequested: pages.length,
      totalProcessed: processedCount,
      results,
    };
  }

  /**
   * ZTTeam: Áp dụng hàng loạt Avatar & Ảnh bìa lên Facebook cho các Page đã có ảnh trong CSDL
   */
  async ztteam_batchApplyBranding(options: { pageIds?: string[]; delayMs?: number } = {}) {
    const { pageIds, delayMs = 5000 } = options;

    const whereClause: any = {
      is_active: true,
      OR: [
        { branding_avatar_url: { not: null } },
        { branding_cover_url: { not: null } },
      ],
    };

    if (pageIds && pageIds.length > 0) {
      whereClause.id = { in: pageIds };
    }

    const pages = await this.prisma.ztteam_pages.findMany({
      where: whereClause,
      orderBy: { name: 'asc' },
    });

    this.logger.log(`[Batch Apply] Bắt đầu áp dụng lên Facebook cho ${pages.length} Fanpage (Delay: ${delayMs}ms)...`);

    const results: any[] = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const index = i + 1;
      this.logger.log(`[Batch Apply] [${index}/${pages.length}] Đang áp dụng cho Page "${page.name}"...`);

      try {
        const applyRes = await this.ztteam_applyPageBranding(page.id, {
          avatarUrl: (page as any).branding_avatar_url || undefined,
          coverUrl: (page as any).branding_cover_url || undefined,
        });

        results.push({
          pageId: page.id,
          name: page.name,
          status: 'SUCCESS',
          result: applyRes,
        });
        successCount++;
        this.logger.log(`[Batch Apply] [${index}/${pages.length}] Page "${page.name}" áp dụng thành công!`);
      } catch (err: any) {
        failCount++;
        const errMsg = err?.message || String(err);
        this.logger.error(`[Batch Apply] [${index}/${pages.length}] Lỗi áp dụng Page "${page.name}": ${errMsg}`);
        results.push({
          pageId: page.id,
          name: page.name,
          status: 'FAILED',
          error: errMsg,
        });
      }

      /** Giãn cách an toàn giữa các request gửi đến Facebook Graph API */
      if (i < pages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return {
      success: true,
      totalRequested: pages.length,
      successCount,
      failCount,
      results,
    };
  }

  /**
   * ZTTeam: Đổi Hạng Mục (Category) hàng loạt cho các Fanpage qua Facebook Graph API
   */
  async ztteam_bulkUpdateCategory(dto: {
    pageIds: string[];
    categoryId: string;
    categoryName: string;
  }) {
    const { pageIds, categoryId, categoryName } = dto;
    if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      throw new BadRequestException('Danh sách Fanpage không được rỗng');
    }
    if (!categoryId) {
      throw new BadRequestException('Vui lòng chọn hoặc nhập ID Hạng mục');
    }

    const pages = await this.prisma.ztteam_pages.findMany({
      where: { id: { in: pageIds } },
    });

    this.logger.log(`[Bulk Category] Bắt đầu đổi hạng mục sang "${categoryName}" (${categoryId}) cho ${pages.length} Fanpage...`);

    const results: any[] = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (!page.page_token_encrypted) {
        failCount++;
        results.push({
          pageId: page.id,
          name: page.name,
          success: false,
          error: 'Fanpage chưa có Token hoặc Token đã hết hạn',
        });
        continue;
      }

      try {
        /** Gọi Facebook Graph API cập nhật category_list */
        await firstValueFrom(
          this.httpService.post(
            `https://graph.facebook.com/${this.API_VERSION}/${page.fb_page_id}`,
            null,
            {
              params: {
                category_list: JSON.stringify([categoryId]),
                access_token: page.page_token_encrypted,
              },
            }
          )
        );

        /** Cập nhật cột category trong DB */
        await this.prisma.ztteam_pages.update({
          where: { id: page.id },
          data: {
            category: categoryName || String(categoryId),
          },
        });

        successCount++;
        results.push({
          pageId: page.id,
          name: page.name,
          success: true,
          category: categoryName,
        });
        this.logger.log(`[Bulk Category] [${i + 1}/${pages.length}] Đổi hạng mục thành công cho Page "${page.name}"`);
      } catch (err: any) {
        failCount++;
        const errMsg = err.response?.data?.error?.message || err.message || 'Lỗi từ Facebook API';
        this.logger.error(`[Bulk Category] [${i + 1}/${pages.length}] Lỗi đổi hạng mục cho Page "${page.name}": ${errMsg}`);
        results.push({
          pageId: page.id,
          name: page.name,
          success: false,
          error: errMsg,
        });
      }

      /** Giãn cách 400ms giữa các request */
      if (i < pages.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    return {
      success: true,
      totalRequested: pages.length,
      successCount,
      failCount,
      categoryId,
      categoryName,
      results,
    };
  }

  /**
   * ZTTeam: Tải ảnh đại diện hoặc ảnh bìa Fanpage thủ công lên lưu trữ hệ thống
   */
  async ztteam_uploadBrandingAsset(
    pageId: string,
    file: any,
    type: 'avatar' | 'cover',
  ) {
    if (!file) {
      throw new BadRequestException('Không tìm thấy file ảnh');
    }
    if (type !== 'avatar' && type !== 'cover') {
      throw new BadRequestException('Loại ảnh không hợp lệ (chỉ hỗ trợ avatar hoặc cover)');
    }

    const page = await this.prisma.ztteam_pages.findFirst({
      where: {
        OR: [{ id: pageId }, { fb_page_id: pageId }],
      },
    });
    if (!page) {
      throw new BadRequestException('Không tìm thấy Fanpage');
    }

    const fs = require('fs');
    const path = require('path');
    const { ztteam_getStorageRoot } = require('../common/ztteam_storage.util');

    const storageDir = path.join(ztteam_getStorageRoot(), 'branding');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    let ext = 'png';
    if (file.mimetype === 'image/jpeg' || file.originalname?.endsWith('.jpg') || file.originalname?.endsWith('.jpeg')) {
      ext = 'jpg';
    } else if (file.mimetype === 'image/webp' || file.originalname?.endsWith('.webp')) {
      ext = 'webp';
    }

    const filename = `manual_${page.id}_${type}_${Date.now()}.${ext}`;
    const targetPath = path.join(storageDir, filename);

    if (file.path && fs.existsSync(file.path)) {
      fs.copyFileSync(file.path, targetPath);
      try { fs.unlinkSync(file.path); } catch (e) {}
    } else if (file.buffer) {
      fs.writeFileSync(targetPath, file.buffer);
    }

    const storageUrl = `/storage/branding/${filename}`;

    /** Cập nhật DB để F5 vẫn hiển thị ảnh này */
    await this.prisma.ztteam_pages.update({
      where: { id: page.id },
      data: {
        ...(type === 'avatar' ? { branding_avatar_url: storageUrl } : { branding_cover_url: storageUrl }),
      },
    });

    return {
      success: true,
      message: `Tải ${type === 'avatar' ? 'Ảnh đại diện' : 'Ảnh bìa'} lên thành công!`,
      type,
      url: storageUrl,
      localPath: targetPath,
    };
  }

  /**
   * ZTTeam: Cập nhật nội dung Caption của bài viết hoặc Video/Reel trên Facebook
   */
  async ztteam_updatePostCaption(fbPageId: string, postId: string, message: string, isVideo = false) {
    const page = await this.prisma.ztteam_pages.findFirst({
      where: {
        OR: [{ fb_page_id: fbPageId }, { id: fbPageId }],
      },
    });

    if (!page || !page.page_token_encrypted) {
      throw new BadRequestException('Fanpage không tồn tại hoặc chưa có Token hợp lệ');
    }

    try {
      const payload: any = {
        access_token: page.page_token_encrypted,
      };
      if (isVideo) {
        payload.description = message;
      } else {
        payload.message = message;
      }

      const res = await firstValueFrom(
        this.httpService.post(
          `https://graph.facebook.com/${this.API_VERSION}/${postId}`,
          null,
          { params: payload }
        )
      );
      return res.data;
    } catch (err: any) {
      const errMsg = err.response?.data?.error?.message || err.message;
      this.logger.error(`Lỗi cập nhật caption cho post ${postId} trên Page ${page.name}: ${errMsg}`);
      throw err;
    }
  }

  /**
   * ZTTeam: Tự động chèn Link bài viết vào Comment hoặc Caption khi đạt ngưỡng view
   */
  async ztteam_injectLinkToPost(params: {
    page: any;
    postId: string;
    wpPostUrl: string;
    placement: 'comment' | 'caption' | 'both';
    currentCaption?: string | null;
    isVideo?: boolean;
    utmSource?: string;
  }) {
    const { page, postId, wpPostUrl, placement, currentCaption = '', isVideo = false, utmSource = 'reel' } = params;
    if (!postId || !wpPostUrl) return { success: false, error: 'Thiếu postId hoặc wpPostUrl' };

    const slugify = (text: string) => {
      if (!text) return '';
      return text.toString().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-').trim();
    };

    const utmMedium = slugify(page?.fb_account?.name || 'account');
    const utmCampaign = slugify(page?.name || 'page');
    const trackingLink = `${wpPostUrl}${wpPostUrl.includes('?') ? '&' : '?'}utm_source=${utmSource}&utm_medium=${utmMedium}&utm_campaign=${utmCampaign}`;

    let commentSuccess = false;
    let captionSuccess = false;

    // 1. Chèn vào Comment
    if (placement === 'comment' || placement === 'both') {
      try {
        const { ztteam_getNewsComment } = require('../common/ztteam_news_comment.util');
        const commentText = ztteam_getNewsComment(trackingLink);
        if (commentText) {
          await this.ztteam_publishComment(page.fb_page_id, postId, commentText);
          commentSuccess = true;
          this.logger.log(`[Link Injection] Đã gắn link vào comment bài ${postId} trên Page "${page.name}"`);
        }
      } catch (cmtErr: any) {
        this.logger.error(`[Link Injection] Lỗi gắn comment cho bài ${postId}: ${cmtErr.message}`);
      }
    }

    // 2. Chèn vào Caption
    if (placement === 'caption' || placement === 'both') {
      try {
        const prefixes = [
          '👉 Discover more here:',
          '🔥 Read the full story:',
          '📌 Check out the details:',
          '👇 Full article link:',
          '🔗 Learn more at:'
        ];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const cleanOldCaption = (currentCaption || '').split(/\n\n.*utm_source=/)[0].trim();
        const newCaption = `${cleanOldCaption}\n\n${prefix} ${trackingLink}`;

        await this.ztteam_updatePostCaption(page.fb_page_id, postId, newCaption, isVideo);
        captionSuccess = true;
        this.logger.log(`[Link Injection] Đã cập nhật caption bài ${postId} trên Page "${page.name}"`);
      } catch (capErr: any) {
        this.logger.error(`[Link Injection] Lỗi cập nhật caption cho bài ${postId}: ${capErr.message}`);
      }
    }

    return {
      success: commentSuccess || captionSuccess,
      commentSuccess,
      captionSuccess,
      placement,
    };
  }
}

