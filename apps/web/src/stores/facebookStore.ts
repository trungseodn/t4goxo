import { create } from 'zustand';
import api from '../services/api';

export interface ZTTeamFanpage {
  id: string;
  name: string;
  accessToken: string;
  category?: string;
  followersCount?: number;
  avatar?: string;
  ownerName?: string;
  status?: string;
  isActive?: boolean;
  targetSiteId?: string;
  targetCategoryId?: string;
  reelFrequencyCron?: string;
  captionTone?: string;
  tags?: string[];
  postFormat?: string;
  scheduleMode?: string;
  autoPublishEnabled?: boolean;
  autoCreateEnabled?: boolean;
  nextPublishTime?: string | null;
  nextRenderTime?: string | null;
  scheduleFixedTimes?: string[];
  scheduleImmediateGapMinutes?: number;
  autoScanIntervalHours?: number;
  defaultReelTemplateId?: string;
  defaultReelTemplateName?: string | null;
  nextVideoTitle?: string | null;
  sourcesCount?: number;
  sources?: any[];
  sourceWebs?: string[];
  primarySourceWeb?: string | null;
  pendingImagesCount?: number;
  pendingReelsCount?: number;
  totalPendingCount?: number;
  addLinkToCaption?: boolean;
  addLinkToComment?: boolean;
  internalId?: string;
  accountType?: string;
  businessId?: string | null;
  businessName?: string | null;
  appId?: string | null;
  appName?: string | null;
  tokenExpiry?: string | null;
}

interface ZTTeamFacebookState {
  isConnected: boolean;
  fbAccountId: string | null;
  pages: ZTTeamFanpage[];
  accounts: any[];
  businesses: any[];
  isLoading: boolean;
  error: string | null;

  ztteam_checkLoginStatus: () => Promise<void>;
  ztteam_fetchPagesFromDB: () => Promise<void>;
  ztteam_fetchAccounts: () => Promise<void>;
  ztteam_fetchBusinesses: () => Promise<void>;
  ztteam_connectBMToken: (token: string) => Promise<any>;
  ztteam_loginWithFacebook: () => Promise<void>;
  ztteam_fetchPages: () => Promise<void>;
  ztteam_testPost: (pageId: string, message: string) => Promise<void>;
  ztteam_updatePageConfig: (pageId: string, config: any) => Promise<void>;
  ztteam_deletePage: (pageId: string) => Promise<any>;
  ztteam_deleteAccount: (accountId: string) => Promise<void>;
  ztteam_getPageReport: (pageId: string) => Promise<any>;
  ztteam_getTopPosts: (pageId: string) => Promise<any>;
}

declare global {
  interface Window {
    FB: any;
  }
}

const ztteamPageReportsCache: Map<string, { time: number; data: any }> = new Map();

export const useZTTeamFacebookStore = create<ZTTeamFacebookState>((set, get) => ({
  isConnected: false,
  fbAccountId: null,
  pages: [],
  accounts: [],
  businesses: [],
  isLoading: false,
  error: null,

  ztteam_checkLoginStatus: async () => {
    /** Load pages from backend DB immediately */
    await get().ztteam_fetchPagesFromDB();

    return new Promise((resolve) => {
      if (!window.FB) {
        resolve();
        return;
      }
      window.FB.getLoginStatus((response: any) => {
        if (response.status === 'connected') {
          set({ isConnected: true, fbAccountId: response.authResponse?.userID });
        }
        resolve();
      });
    });
  },

  ztteam_fetchPagesFromDB: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.get('/facebook/pages');
      const pages = response.data;
      if (pages.length > 0) {
        set({ pages, isConnected: true, isLoading: false });
      } else {
        set({ pages: [], isLoading: false });
      }
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to fetch pages from database', isLoading: false });
    }
  },

  ztteam_loginWithFacebook: async () => {
    set({ isLoading: true, error: null });
    return new Promise((resolve, reject) => {
      const ztteam_triggerLogin = () => {
        if (!window.FB) {
          set({ error: 'Facebook SDK chưa tải xong, vui lòng thử lại sau vài giây', isLoading: false });
          reject(new Error('Facebook SDK is not loaded'));
          return;
        }

        try {
          /** ZTTeam: Đảm bảo FB.init luôn được kích hoạt an toàn với App ID chuẩn trước khi gọi login */
          const rawAppId = import.meta.env.VITE_FB_APP_ID;
          const appId = (rawAppId && !rawAppId.includes('%')) ? rawAppId : '1346835604110691';
          window.FB.init({
            appId      : appId,
            cookie     : true,
            xfbml      : true,
            version    : 'v20.0'
          });
        } catch (e) {
          /** Đã init trước đó */
        }

        window.FB.login((response: any) => {
          if (response.authResponse) {
            const { accessToken, userID } = response.authResponse;
            
            /** Gửi token ngắn hạn cho Backend đổi lấy token dài hạn */
            api.post('/facebook/exchange-token', { shortToken: accessToken, fbAccountId: userID })
              .then(() => {
                set({ isConnected: true, fbAccountId: userID, isLoading: false });
                return get().ztteam_fetchPages();
              })
              .then(() => resolve())
              .catch((error) => {
                set({ error: error.response?.data?.message || 'Failed to exchange token', isLoading: false });
                reject(error);
              });
          } else {
            set({ error: 'User cancelled login or did not fully authorize.', isLoading: false });
            reject(new Error('User cancelled login'));
          }
        }, { 
            /** ZTTeam: Bổ sung pages_manage_engagement và pages_read_user_content để có quyền tự động đăng bình luận và tương tác */
            scope: 'pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement,pages_read_user_content',
            auth_type: 'rerequest'
          });
      };

      if (!window.FB) {
        window.addEventListener('fbSDKLoaded', ztteam_triggerLogin, { once: true });
        setTimeout(() => {
          if (window.FB) {
            ztteam_triggerLogin();
          } else {
            set({ error: 'Không thể kết nối với Facebook SDK. Vui lòng kiểm tra lại tiện ích chặn quảng cáo/Adblock.', isLoading: false });
            reject(new Error('Facebook SDK is not loaded'));
          }
        }, 2000);
      } else {
        ztteam_triggerLogin();
      }
    });
  },

  ztteam_fetchPages: async () => {
    const { fbAccountId } = get();
    set({ isLoading: true, error: null });
    try {
      if (fbAccountId) {
        await api.post(`/facebook/pages/${fbAccountId}/fetch`);
      }
    } catch (error: any) {
      set({ error: error.response?.data?.message || 'Failed to fetch pages' });
    } finally {
      await get().ztteam_fetchPagesFromDB();
    }
  },

  ztteam_testPost: async (pageId: string, message: string) => {
    try {
      await api.post(`/facebook/pages/${pageId}/test-post`, { message });
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Lỗi khi đăng bài test');
    }
  },

  ztteam_updatePageConfig: async (pageId: string, config: any) => {
    try {
      await api.put(`/facebook/pages/${pageId}/settings`, config);
      set((state) => ({
        pages: state.pages.map(p => p.id === pageId ? { ...p, ...config } : p)
      }));
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Lỗi khi lưu cấu hình');
    }
  },

  ztteam_deletePage: async (pageId: string) => {
    try {
      const response = await api.delete(`/facebook/pages/${pageId}`);
      await get().ztteam_fetchPagesFromDB();
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Lỗi khi xóa Fanpage');
    }
  },

  ztteam_deleteAccount: async (accountId: string) => {
    try {
      await api.delete(`/facebook/accounts/${accountId}`);
      await get().ztteam_fetchAccounts();
      await get().ztteam_fetchPagesFromDB();
    } catch (error: any) {
      throw new Error(error.response?.data?.message || 'Lỗi khi xóa tài khoản Facebook');
    }
  },

  ztteam_fetchAccounts: async () => {
    try {
      const response = await api.get('/facebook/accounts');
      set({ accounts: response.data || [] });
    } catch (error: any) {
      console.error('Error fetching fb accounts', error);
    }
  },

  ztteam_fetchBusinesses: async () => {
    try {
      const response = await api.get('/facebook/businesses');
      set({ businesses: response.data || [] });
    } catch (error: any) {
      console.error('Error fetching businesses', error);
    }
  },

  ztteam_connectBMToken: async (token: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.post('/facebook/connect-bm-token', { token });
      await get().ztteam_fetchPagesFromDB();
      await get().ztteam_fetchBusinesses();
      set({ isLoading: false });
      return response.data;
    } catch (error: any) {
      const msg = error.response?.data?.message || error.message || 'Lỗi kết nối Token BM';
      set({ error: msg, isLoading: false });
      throw new Error(msg);
    }
  },

  ztteam_getPageReport: async (pageId: string) => {
    const cached = ztteamPageReportsCache.get(pageId);
    if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
      return cached.data;
    }
    try {
      const response = await api.get(`/facebook/pages/${pageId}/report`);
      ztteamPageReportsCache.set(pageId, { time: Date.now(), data: response.data });
      return response.data;
    } catch (error: any) {
      console.error('Error fetching page report', error);
      return [];
    }
  },

  ztteam_getTopPosts: async (pageId: string) => {
    try {
      const response = await api.get(`/facebook/pages/${pageId}/top-posts`);
      return response.data;
    } catch (error: any) {
      console.error('Error fetching top posts', error);
      return [];
    }
  }
}));
