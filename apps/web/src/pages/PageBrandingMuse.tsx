import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useZTTeamFacebookStore } from '../stores/facebookStore';
import { useUIStore } from '../stores/uiStore';
import CustomDropdown from '../components/CustomDropdown';
import api from '../services/api';

/** Danh sách Preset Chủ Đề được tối ưu hóa cho Muse.ai */
const THEME_PRESETS = [
  {
    id: 'history_mystery',
    name: '📜 Lịch Sử & Bí Ẩn Cổ Xưa',
    desc: 'Tư liệu cổ kính, bóng tối điện ảnh, chi tiết huyền bí và không gian lưu trữ tài liệu.',
    avatarPrompt: 'Create a 1:1 square iconic profile picture avatar for a storytelling page named "{PAGE_NAME}". Theme: historical mysteries, lost archives, and forgotten secrets. Cinematic dramatic lighting, rich atmospheric textures, deep shadows, 8k resolution, minimalist emblem style, photorealistic.',
    coverPrompt: 'Create a breathtaking cinematic 16:9 widescreen Facebook cover banner for "{PAGE_NAME}". Theme: ancient historical archive, mysterious documents, dramatic storytelling mood, rich vintage textures, volumetric lighting, photorealistic masterpiece, 8k.',
  },
  {
    id: 'unsolved_cases',
    name: '🔍 Hồ Sơ Vụ Án & Ly Kỳ',
    desc: 'Không khí trinh thám, điều tra bí mật, ánh đèn neon mờ ảo, bóng đêm kịch tính.',
    avatarPrompt: 'Create a 1:1 square profile picture avatar for a mystery investigation page named "{PAGE_NAME}". Theme: unsolved cold cases, detective archives, dark noir aesthetics. High contrast, cinematic chiaroscuro lighting, subtle emblem symbol, photorealistic, 8k.',
    coverPrompt: 'Create an intense 16:9 cinematic widescreen Facebook cover banner for "{PAGE_NAME}". Theme: detective case files, investigative journalism, atmospheric fog, moody dramatic street lighting, photorealistic cinematic storytelling, 8k resolution.',
  },
  {
    id: 'emotional_narrative',
    name: '📖 Kể Chuyện Đời Sống & Cảm Xúc',
    desc: 'Tone màu ấm áp, ánh hoàng hôn, câu chuyện chạm đến trái tim và sự đồng cảm.',
    avatarPrompt: 'Create a 1:1 square emotive profile picture avatar for a narrative storytelling page named "{PAGE_NAME}". Theme: heartfelt human stories, warm golden hour lighting, deep emotional atmosphere, elegant artistic symbol, 8k resolution, photorealistic.',
    coverPrompt: 'Create a breathtaking 16:9 cinematic cover banner for "{PAGE_NAME}". Theme: emotional storytelling journey, picturesque cinematic landscape with warm nostalgic lighting, deeply evocative atmosphere, 8k masterpiece.',
  },
  {
    id: 'modern_editorial',
    name: '⚡ Khám Phá & Báo Chí Hiện Đại',
    desc: 'Phong cách hiện đại, tương phản cao, góc nhìn báo chí và khám phá thế giới.',
    avatarPrompt: 'Create a 1:1 modern minimalist profile picture avatar for a documentary media page named "{PAGE_NAME}". Bold visual identity, clean typography badge, striking contrast, sleek studio lighting, 8k resolution.',
    coverPrompt: 'Create an ultra-modern 16:9 documentary editorial cover banner for "{PAGE_NAME}". Dynamic composition, global perspectives, high-impact cinematic aesthetics, clean visual storytelling, 8k.',
  },
  {
    id: 'custom',
    name: '✍️ Tùy Biến Tự Do',
    desc: 'Tự nhập câu lệnh prompt chi tiết theo phong cách riêng của bạn.',
    avatarPrompt: '',
    coverPrompt: '',
  },
];

export default function PageBrandingMuse() {
  const navigate = useNavigate();
  const { pages, ztteam_fetchPagesFromDB, isLoading } = useZTTeamFacebookStore();
  const { ztteam_showToast, ztteam_showConfirm } = useUIStore();

  /** State Điều hướng Tabs chính */
  const [activeTab, setActiveTab] = useState<1 | 2 | 3>(1);

  /** Bộ lọc BM & Tìm kiếm */
  const [selectedBm, setSelectedBm] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterMode, setFilterMode] = useState<'missing_only' | 'missing_cover' | 'missing_avatar' | 'has_branding' | 'all'>('missing_only');

  /** Danh sách ID Page được chọn */
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);

  /** Cấu hình Prompt Studio */
  const [selectedThemeId, setSelectedThemeId] = useState<string>('history_mystery');
  const [customAvatarPrompt, setCustomAvatarPrompt] = useState<string>(THEME_PRESETS[0].avatarPrompt);
  const [customCoverPrompt, setCustomCoverPrompt] = useState<string>(THEME_PRESETS[0].coverPrompt);
  const [includePageNameText, setIncludePageNameText] = useState<boolean>(true);
  const [autoApplyFacebook, setAutoApplyFacebook] = useState<boolean>(true);
  const [brandingTargetType, setBrandingTargetType] = useState<'both' | 'avatar' | 'cover'>('both');

  /** Trạng thái Hàng Đợi & Tiến Trình */
  const [queueStatus, setQueueStatus] = useState<any>(null);
  const [isSubmittingQueue, setIsSubmittingQueue] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [activePreviewPage, setActivePreviewPage] = useState<any>(null);
  const [isApplyingFacebook, setIsApplyingFacebook] = useState<string | null>(null);

  /** Tải lại dữ liệu khi vào trang */
  const refreshData = async () => {
    setIsRefreshing(true);
    try {
      await ztteam_fetchPagesFromDB();
      const res = await api.get('/facebook/pages/branding/queue-status');
      if (res.data?.success) {
        setQueueStatus(res.data);
      }
    } catch (e: any) {
      console.warn('Lỗi tải queue status:', e.message);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    refreshData();
    /** Polling nhẹ trạng thái hàng đợi mỗi 10 giây nếu đang ở Tab 3 */
    const interval = setInterval(() => {
      api.get('/facebook/pages/branding/queue-status')
        .then(res => {
          if (res.data?.success) setQueueStatus(res.data);
        })
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  /** Danh sách Business Manager duy nhất */
  const uniqueBusinesses = useMemo(() => {
    const bms = Array.from(new Set(pages.map(p => p.businessName).filter(Boolean)));
    return bms;
  }, [pages]);

  /** Danh sách Fanpage sau khi lọc */
  const filteredPages = useMemo(() => {
    return pages.filter(p => {
      if (p.isActive === false) return false;

      /** Lọc theo BM */
      if (selectedBm !== 'all' && p.businessName !== selectedBm) {
        return false;
      }

      /** Lọc theo Search */
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = (p.name || '').toLowerCase().includes(q);
        const matchId = (p.fb_page_id || p.id || '').includes(q);
        if (!matchName && !matchId) return false;
      }

      /** Lọc theo Trạng thái Nhận diện */
      const hasAvatar = !!p.brandingAvatarUrl;
      const hasCover = !!p.brandingCoverUrl;

      if (filterMode === 'missing_only') return !hasAvatar || !hasCover;
      if (filterMode === 'missing_cover') return !hasCover;
      if (filterMode === 'missing_avatar') return !hasAvatar;
      if (filterMode === 'has_branding') return hasAvatar && hasCover;

      return true;
    });
  }, [pages, selectedBm, searchQuery, filterMode]);

  /** Đổi Preset Chủ đề */
  const handleSelectThemePreset = (themeId: string) => {
    setSelectedThemeId(themeId);
    const preset = THEME_PRESETS.find(t => t.id === themeId);
    if (preset && themeId !== 'custom') {
      setCustomAvatarPrompt(preset.avatarPrompt);
      setCustomCoverPrompt(preset.coverPrompt);
    }
  };

  /** Xử lý Chọn tất cả các Page đang hiển thị */
  const handleToggleSelectAll = () => {
    const allFilteredIds = filteredPages.map(p => p.id);
    const isAllSelected = allFilteredIds.every(id => selectedPageIds.includes(id));
    if (isAllSelected) {
      setSelectedPageIds(prev => prev.filter(id => !allFilteredIds.includes(id)));
    } else {
      setSelectedPageIds(prev => Array.from(new Set([...prev, ...allFilteredIds])));
    }
  };

  /** Xử lý Chọn / Bỏ chọn 1 Page */
  const handleToggleSelectPage = (pageId: string) => {
    setSelectedPageIds(prev => 
      prev.includes(pageId) ? prev.filter(id => id !== pageId) : [...prev, pageId]
    );
  };

  /** Đưa Fanpage đã chọn vào Hàng Đợi Muse */
  const handleQueueBrandingSubmit = async () => {
    const targetPages = selectedPageIds.length > 0 
      ? pages.filter(p => selectedPageIds.includes(p.id))
      : filteredPages;

    if (targetPages.length === 0) {
      ztteam_showToast('Vui lòng chọn ít nhất 1 Fanpage để đưa vào hàng đợi', 'error');
      return;
    }

    const confirm = await ztteam_showConfirm(
      'Xác nhận Đưa vào Hàng Đợi Muse',
      `Bạn chuẩn bị đưa ${targetPages.length} Fanpage vào hàng đợi tạo nhận diện bằng Muse.ai.\n\n` +
      `- Định dạng: ${brandingTargetType === 'both' ? 'Cả Avatar (1:1) và Ảnh bìa (16:9)' : brandingTargetType === 'avatar' ? 'Chỉ Avatar (1:1)' : 'Chỉ Ảnh bìa (16:9)'}\n` +
      `- Tự động cập nhật Facebook: ${autoApplyFacebook ? 'BẬT' : 'TẮT (Chỉ lưu trữ)'}\n\n` +
      `Tiến trình sẽ được xử lý tự động khi Worker Muse trên máy tính hoạt động. Bạn có muốn tiếp tục?`
    );

    if (!confirm) return;

    try {
      setIsSubmittingQueue(true);
      const res = await api.post('/facebook/pages/branding/bulk-queue', {
        scope: 'selected',
        pageIds: targetPages.map(p => p.id),
        customAvatarPrompt,
        customCoverPrompt,
        theme: selectedThemeId,
        autoApplyFacebook,
        brandingType: brandingTargetType,
      });

      if (res.data?.success) {
        ztteam_showToast(res.data.message || `Đã đưa ${res.data.totalQueued} Fanpage vào hàng đợi Muse!`, 'success');
        setActiveTab(3); // Chuyển sang Tab Hàng Đợi để theo dõi
        await refreshData();
      } else {
        ztteam_showToast(res.data?.message || 'Không có Fanpage nào được thêm vào hàng đợi', 'info');
      }
    } catch (err: any) {
      ztteam_showToast(err.response?.data?.message || err.message || 'Lỗi khi gửi vào hàng đợi', 'error');
    } finally {
      setIsSubmittingQueue(false);
    }
  };

  /** Áp dụng Ảnh lên Facebook thủ công */
  const handleApplySinglePageFacebook = async (page: any) => {
    const confirm = await ztteam_showConfirm(
      'Áp Dụng Lên Facebook',
      `Hệ thống sẽ cập nhật Avatar và Ảnh bìa đã tạo lên Fanpage "${page.name}". Quá trình này dùng cờ ẩn để không spam bảng tin. Bạn có muốn áp dụng?`
    );
    if (!confirm) return;

    try {
      setIsApplyingFacebook(page.id);
      const res = await api.post(`/facebook/pages/${page.id}/branding/apply`, {
        avatarUrl: page.brandingAvatarUrl || undefined,
        coverUrl: page.brandingCoverUrl || undefined,
      });
      if (res.data?.success) {
        ztteam_showToast(res.data.message || `Đã cập nhật Avatar & Ảnh bìa cho Fanpage "${page.name}" thành công!`, 'success');
        await refreshData();
      }
    } catch (err: any) {
      ztteam_showToast(err.response?.data?.message || err.message || 'Lỗi khi gắn lên Facebook', 'error');
    } finally {
      setIsApplyingFacebook(null);
    }
  };

  /** Reset hoặc Hủy bỏ Job */
  const handleResetJob = async (pageId: string) => {
    try {
      await api.post(`/facebook/pages/branding/${pageId}/reset`);
      ztteam_showToast('Đã đặt lại trạng thái nhận diện cho Page', 'success');
      await refreshData();
    } catch (err: any) {
      ztteam_showToast(err.message, 'error');
    }
  };

  /** Thống kê nhanh */
  const stats = useMemo(() => {
    const total = pages.filter(p => p.isActive !== false).length;
    const hasAvatar = pages.filter(p => p.isActive !== false && p.brandingAvatarUrl).length;
    const hasCover = pages.filter(p => p.isActive !== false && p.brandingCoverUrl).length;
    const missingAny = pages.filter(p => p.isActive !== false && (!p.brandingAvatarUrl || !p.brandingCoverUrl)).length;
    return { total, hasAvatar, hasCover, missingAny };
  }, [pages]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      {/** HEADER CHÍNH */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-fb-surface-hover/50">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
            <span className="material-symbols-outlined text-2xl">palette</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight">
                Tạo Ảnh Bìa & Avatar Theo Chủ Đề (Muse.ai)
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-mono">
                MUSE RPA
              </span>
            </div>
            <p className="text-xs text-fb-text-muted mt-1">
              Hệ thống tự động hóa tạo nhận diện thương hiệu chuẩn điện ảnh theo từng Business Manager (BM), bám sát chủ đề Story và chèn tên Fanpage nghệ thuật.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={refreshData}
            disabled={isRefreshing}
            className="px-3 py-2 bg-fb-surface border border-fb-surface-hover/70 hover:bg-fb-surface-hover text-slate-300 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-all cursor-pointer shadow-xs"
            title="Tải lại dữ liệu"
          >
            <span className={`material-symbols-outlined text-[16px] ${isRefreshing ? 'animate-spin text-emerald-400' : ''}`}>
              refresh
            </span>
            <span>{isRefreshing ? 'Đang tải...' : 'Làm mới'}</span>
          </button>

          <button
            onClick={() => navigate('/facebook')}
            className="px-4 py-2 bg-fb-surface-hover hover:bg-fb-surface-hover/80 text-fb-text font-bold rounded-xl text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            <span>Quay lại Fanpage</span>
          </button>
        </div>
      </div>

      {/** THẺ KPI THỐNG KÊ NHẬN DIỆN */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-fb-surface p-4 rounded-2xl border border-fb-surface-hover/50 shadow-sm space-y-1">
          <div className="text-[11px] font-bold text-fb-text-muted uppercase tracking-wider flex items-center justify-between">
            <span>Tổng Fanpage</span>
            <span className="material-symbols-outlined text-base text-slate-400">flag</span>
          </div>
          <div className="text-2xl font-black text-white">{stats.total}</div>
          <div className="text-[11px] text-slate-400">Đang hoạt động trên hệ thống</div>
        </div>

        <div className="bg-fb-surface p-4 rounded-2xl border border-fb-surface-hover/50 shadow-sm space-y-1">
          <div className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider flex items-center justify-between">
            <span>Đã Có Avatar</span>
            <span className="material-symbols-outlined text-base text-emerald-400">account_circle</span>
          </div>
          <div className="text-2xl font-black text-emerald-400">{stats.hasAvatar}</div>
          <div className="text-[11px] text-slate-400">Avatar thương hiệu chuẩn 1:1</div>
        </div>

        <div className="bg-fb-surface p-4 rounded-2xl border border-fb-surface-hover/50 shadow-sm space-y-1">
          <div className="text-[11px] font-bold text-teal-400 uppercase tracking-wider flex items-center justify-between">
            <span>Đã Có Ảnh Bìa</span>
            <span className="material-symbols-outlined text-base text-teal-400">panorama</span>
          </div>
          <div className="text-2xl font-black text-teal-400">{stats.hasCover}</div>
          <div className="text-[11px] text-slate-400">Cover banner 16:9 sắc nét</div>
        </div>

        <div className="bg-fb-surface p-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 shadow-sm space-y-1">
          <div className="text-[11px] font-bold text-amber-400 uppercase tracking-wider flex items-center justify-between">
            <span>Chưa Có Nhận Diện</span>
            <span className="material-symbols-outlined text-base text-amber-400">warning</span>
          </div>
          <div className="text-2xl font-black text-amber-400">{stats.missingAny}</div>
          <div className="text-[11px] text-amber-300/80 font-medium">Thiếu Avatar hoặc Ảnh bìa</div>
        </div>
      </div>

      {/** THANH CHUYỂN TABS CHUẨN (GIỐNG FACEBOOK PAGE SETTINGS) */}
      <div className="flex border-b border-fb-surface-hover/50 space-x-1 sm:space-x-3 overflow-x-auto">
        <button
          onClick={() => setActiveTab(1)}
          className={`px-5 py-3 font-bold text-xs sm:text-sm flex items-center gap-2 border-b-2 rounded-t-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 1
              ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5 shadow-xs'
              : 'border-transparent text-fb-text-muted hover:text-fb-text hover:bg-fb-surface-hover/40'
          }`}
        >
          <span className="material-symbols-outlined text-lg">checklist</span>
          <span>1. Chọn BM & Fanpage</span>
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
            activeTab === 1 ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-fb-surface-hover text-slate-400 border-white/5'
          }`}>
            {filteredPages.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab(2)}
          className={`px-5 py-3 font-bold text-xs sm:text-sm flex items-center gap-2 border-b-2 rounded-t-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 2
              ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5 shadow-xs'
              : 'border-transparent text-fb-text-muted hover:text-fb-text hover:bg-fb-surface-hover/40'
          }`}
        >
          <span className="material-symbols-outlined text-lg">tune</span>
          <span>2. Tùy Chỉnh Prompt & Chủ Đề</span>
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 font-mono">
            {THEME_PRESETS.find(t => t.id === selectedThemeId)?.name.slice(0, 10)}...
          </span>
        </button>

        <button
          onClick={() => setActiveTab(3)}
          className={`px-5 py-3 font-bold text-xs sm:text-sm flex items-center gap-2 border-b-2 rounded-t-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === 3
              ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5 shadow-xs'
              : 'border-transparent text-fb-text-muted hover:text-fb-text hover:bg-fb-surface-hover/40'
          }`}
        >
          <span className="material-symbols-outlined text-lg">view_carousel</span>
          <span>3. Hàng Đợi & Xem Trước Ảnh</span>
          {queueStatus?.queue?.totalActiveJobs > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse">
              {queueStatus.queue.totalActiveJobs} Đang chạy
            </span>
          )}
        </button>
      </div>

      {/** =========================================================================
       * TAB 1: CHỌN BM & BỘ LỌC FANPAGE
       * ========================================================================= */}
      {activeTab === 1 && (
        <div className="space-y-5 animate-in fade-in duration-200">
          {/** Khung Lọc: BM + Search + Tình trạng */}
          <div className="bg-fb-surface rounded-2xl shadow-lg border border-fb-surface-hover/50 p-4 sm:p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
              {/** Chọn BM */}
              <div className="md:col-span-5 space-y-1.5">
                <label className="block text-xs font-bold text-fb-text flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-base text-blue-400">corporate_fare</span>
                  <span>Chọn Business Manager (BM):</span>
                </label>
                <CustomDropdown
                  value={selectedBm}
                  onChange={val => setSelectedBm(val)}
                  options={[
                    { value: 'all', label: `🏢 Tất cả Doanh nghiệp (${stats.total} Page)` },
                    ...uniqueBusinesses.map(bm => ({
                      value: bm as string,
                      label: `🏢 ${bm} (${pages.filter(p => p.businessName === bm && p.isActive !== false).length} Page)`
                    }))
                  ]}
                  className="w-full"
                />
              </div>

              {/** Ô Tìm Kiếm */}
              <div className="md:col-span-4 space-y-1.5">
                <label className="block text-xs font-bold text-fb-text-muted flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-base">search</span>
                  <span>Tìm kiếm Fanpage:</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Nhập tên Fanpage hoặc ID..."
                    className="w-full px-3.5 py-2 pl-9 bg-fb-surface-hover/30 border border-fb-surface-hover/60 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/60"
                  />
                  <span className="material-symbols-outlined absolute left-2.5 top-2.5 text-slate-400 text-sm">
                    search
                  </span>
                </div>
              </div>

              {/** Nút Thao Tác Nhanh */}
              <div className="md:col-span-3 flex items-center gap-2">
                <button
                  onClick={handleToggleSelectAll}
                  className="flex-1 py-2 px-3 bg-fb-surface-hover/50 hover:bg-fb-surface-hover border border-fb-surface-hover/70 text-slate-200 text-xs font-bold rounded-xl transition-all cursor-pointer text-center"
                >
                  {filteredPages.length > 0 && filteredPages.every(p => selectedPageIds.includes(p.id))
                    ? 'Bỏ chọn tất cả'
                    : `Chọn tất cả (${filteredPages.length})`}
                </button>
              </div>
            </div>

            {/** Bộ Lọc Trạng Thái Nhận Diện (Pill Buttons) */}
            <div className="pt-3 border-t border-fb-surface-hover/40 flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-fb-text-muted mr-1">Bộ lọc nhanh:</span>

              <button
                type="button"
                onClick={() => setFilterMode('missing_only')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer flex items-center gap-1.5 ${
                  filterMode === 'missing_only'
                    ? 'bg-amber-500/20 border-amber-500 text-amber-300 shadow-xs'
                    : 'bg-fb-surface-hover/20 border-slate-700/60 text-slate-400 hover:border-slate-500'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">warning</span>
                <span>Chưa có ảnh bìa hoặc avatar</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-amber-500/30 text-amber-200">
                  {stats.missingAny}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setFilterMode('missing_cover')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer flex items-center gap-1.5 ${
                  filterMode === 'missing_cover'
                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-xs'
                    : 'bg-fb-surface-hover/20 border-slate-700/60 text-slate-400 hover:border-slate-500'
                }`}
              >
                <span>Chỉ thiếu Ảnh bìa</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300">
                  {stats.total - stats.hasCover}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setFilterMode('missing_avatar')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer flex items-center gap-1.5 ${
                  filterMode === 'missing_avatar'
                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-xs'
                    : 'bg-fb-surface-hover/20 border-slate-700/60 text-slate-400 hover:border-slate-500'
                }`}
              >
                <span>Chỉ thiếu Avatar</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300">
                  {stats.total - stats.hasAvatar}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setFilterMode('all')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                  filterMode === 'all'
                    ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-xs'
                    : 'bg-fb-surface-hover/20 border-slate-700/60 text-slate-400 hover:border-slate-500'
                }`}
              >
                <span>Tất cả Fanpage ({stats.total})</span>
              </button>
            </div>
          </div>

          {/** Bảng Danh Sách Fanpage */}
          <div className="bg-fb-surface rounded-2xl shadow-lg border border-fb-surface-hover/50 overflow-hidden">
            <div className="p-3.5 bg-slate-800/60 border-b border-fb-surface-hover/60 flex items-center justify-between text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={filteredPages.length > 0 && filteredPages.every(p => selectedPageIds.includes(p.id))}
                  onChange={handleToggleSelectAll}
                  className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-900 cursor-pointer"
                />
                <span className="font-bold">Danh sách Fanpage ({filteredPages.length} Page phù hợp)</span>
              </div>
              <div className="text-emerald-400 font-mono font-bold text-xs">
                Đã chọn: {selectedPageIds.length} Page
              </div>
            </div>

            <div className="divide-y divide-fb-surface-hover/40 max-h-[550px] overflow-y-auto">
              {filteredPages.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs space-y-1">
                  <span className="material-symbols-outlined text-3xl text-slate-500">filter_none</span>
                  <div>Không tìm thấy Fanpage nào phù hợp với bộ lọc hiện tại.</div>
                </div>
              ) : (
                filteredPages.map(page => {
                  const isSelected = selectedPageIds.includes(page.id);
                  const hasAvatar = !!page.brandingAvatarUrl;
                  const hasCover = !!page.brandingCoverUrl;

                  return (
                    <div
                      key={page.id}
                      onClick={() => handleToggleSelectPage(page.id)}
                      className={`p-3.5 flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                        isSelected ? 'bg-emerald-500/10 hover:bg-emerald-500/15' : 'hover:bg-fb-surface-hover/30'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleSelectPage(page.id)}
                          onClick={e => e.stopPropagation()}
                          className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-900 cursor-pointer shrink-0"
                        />

                        {/** Avatar Thumbnail */}
                        <div className="relative w-10 h-10 rounded-xl overflow-hidden bg-slate-800 border border-slate-700/60 shrink-0">
                          {page.avatar ? (
                            <img src={page.avatar} alt={page.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-500 font-bold text-xs">
                              {page.name.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                          {hasAvatar && (
                            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 rounded-full border border-slate-900" title="Đã có Avatar tùy chỉnh" />
                          )}
                        </div>

                        {/** Thông tin Page */}
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-white text-xs sm:text-sm truncate flex items-center gap-2">
                            <span>{page.name}</span>
                            {page.businessName && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-normal shrink-0">
                                {page.businessName}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                            <span className="font-mono">ID: {page.fb_page_id || page.id}</span>
                            <span>•</span>
                            <span className="text-emerald-400/90">{page.primarySourceWeb || 'history.imsb.info'}</span>
                          </div>
                        </div>
                      </div>

                      {/** Cột Trạng Thái Nhận Diện */}
                      <div className="flex items-center gap-2.5 shrink-0">
                        {/** Trạng thái Avatar */}
                        {hasAvatar ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                            <span className="material-symbols-outlined text-[12px]">check_circle</span>
                            Avatar 1:1
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                            <span className="material-symbols-outlined text-[12px]">hide_image</span>
                            Thiếu Avatar
                          </span>
                        )}

                        {/** Trạng thái Cover */}
                        {hasCover ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-500/15 text-teal-400 border border-teal-500/30">
                            <span className="material-symbols-outlined text-[12px]">check_circle</span>
                            Ảnh bìa 16:9
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                            <span className="material-symbols-outlined text-[12px]">panorama</span>
                            Thiếu Cover
                          </span>
                        )}

                        {/** Nút Chuyển nhanh qua tab cấu hình */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedPageIds([page.id]);
                            setActiveTab(2);
                          }}
                          className="p-1.5 hover:bg-fb-surface-hover rounded-lg text-slate-400 hover:text-white transition-colors"
                          title="Cấu hình Prompt cho Page này"
                        >
                          <span className="material-symbols-outlined text-sm">edit_note</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/** Footer Bảng */}
            <div className="p-3 bg-slate-900/40 border-t border-fb-surface-hover/50 flex items-center justify-between">
              <div className="text-xs text-slate-400">
                Hiển thị <b className="text-white">{filteredPages.length}</b> Fanpage
              </div>
              <button
                type="button"
                onClick={() => setActiveTab(2)}
                className="px-5 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:opacity-90 text-white font-bold rounded-xl text-xs flex items-center gap-2 shadow-lg shadow-emerald-500/20 transition-all cursor-pointer"
              >
                <span>Tiếp tục sang bước 2: Tùy chỉnh Prompt</span>
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/** =========================================================================
       * TAB 2: STUDIO TÙY CHỈNH PROMPT & CHỦ ĐỀ
       * ========================================================================= */}
      {activeTab === 2 && (
        <div className="space-y-6 animate-in fade-in duration-200">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/** Cột Trái: Chọn Preset & Tùy chỉnh Prompt */}
            <div className="lg:col-span-8 space-y-5">
              {/** Khối 1: Chọn Preset Chủ đề */}
              <div className="bg-fb-surface rounded-2xl shadow-lg border border-fb-surface-hover/50 p-5 space-y-3">
                <label className="block text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-base">style</span>
                  <span>1. Chọn Phong Cách & Chủ Đề Mẫu</span>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {THEME_PRESETS.map(preset => {
                    const isSelected = selectedThemeId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => handleSelectThemePreset(preset.id)}
                        className={`p-3 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                          isSelected
                            ? 'bg-emerald-500/15 border-emerald-500 text-white font-bold shadow-md shadow-emerald-500/10'
                            : 'bg-fb-surface-hover/20 border-slate-700/60 text-slate-400 hover:border-slate-500'
                        }`}
                      >
                        <div className="text-xs font-bold text-white flex items-center justify-between">
                          <span>{preset.name}</span>
                          {isSelected && <span className="material-symbols-outlined text-sm text-emerald-400">check</span>}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1 line-clamp-2 leading-relaxed">
                          {preset.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/** Khối 2: Prompt Avatar 1:1 */}
              <div className="bg-fb-surface rounded-2xl shadow-lg border border-fb-surface-hover/50 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-base">account_circle</span>
                    <span>2. Prompt Ảnh Đại Diện (Avatar 1:1)</span>
                  </label>
                  <span className="text-[11px] font-mono text-slate-400">Vuông 1024x1024</span>
                </div>
                <textarea
                  rows={4}
                  value={customAvatarPrompt}
                  onChange={e => setCustomAvatarPrompt(e.target.value)}
                  placeholder="Nhập câu lệnh prompt tiếng Anh cho Avatar..."
                  className="w-full p-3.5 bg-slate-900/60 border border-slate-700/60 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 font-mono leading-relaxed"
                />
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                  <span>Biến mẫu:</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-emerald-400 font-mono">
                    {'{PAGE_NAME}'}
                  </span>
                  <span>= Tên Fanpage;</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-teal-400 font-mono">
                    {'{THEME}'}
                  </span>
                  <span>= Chủ đề</span>
                </div>
              </div>

              {/** Khối 3: Prompt Cover 16:9 */}
              <div className="bg-fb-surface rounded-2xl shadow-lg border border-fb-surface-hover/50 p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-teal-400 uppercase tracking-wider flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-base">panorama</span>
                    <span>3. Prompt Ảnh Bìa Fanpage (Cover 16:9)</span>
                  </label>
                  <span className="text-[11px] font-mono text-slate-400">Cinematic Banner 16:9</span>
                </div>
                <textarea
                  rows={4}
                  value={customCoverPrompt}
                  onChange={e => setCustomCoverPrompt(e.target.value)}
                  placeholder="Nhập câu lệnh prompt tiếng Anh cho Ảnh bìa..."
                  className="w-full p-3.5 bg-slate-900/60 border border-slate-700/60 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-teal-500 font-mono leading-relaxed"
                />
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                  <span>Biến mẫu:</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-emerald-400 font-mono">
                    {'{PAGE_NAME}'}
                  </span>
                  <span>= Tên Fanpage;</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-teal-400 font-mono">
                    {'{THEME}'}
                  </span>
                  <span>= Chủ đề</span>
                </div>
              </div>
            </div>

            {/** Cột Phải: Cấu hình Thực thi & Nút Hành Động */}
            <div className="lg:col-span-4 space-y-5">
              <div className="bg-fb-surface rounded-2xl shadow-lg border border-fb-surface-hover/50 p-5 space-y-4">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5 pb-2 border-b border-fb-surface-hover/40">
                  <span className="material-symbols-outlined text-base text-emerald-400">tune</span>
                  <span>Tùy Chọn Thực Thi</span>
                </h3>

                {/** Loại hình ảnh muốn tạo */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-fb-text">Loại ảnh cần Muse tạo:</label>
                  <CustomDropdown
                    value={brandingTargetType}
                    onChange={val => setBrandingTargetType(val as any)}
                    options={[
                      { value: 'both', label: 'Cả Avatar (1:1) & Ảnh Bìa (16:9)' },
                      { value: 'avatar', label: 'Chỉ tạo Avatar (1:1)' },
                      { value: 'cover', label: 'Chỉ tạo Ảnh Bìa (16:9)' },
                    ]}
                  />
                </div>

                {/** Switch 1: Tự động cập nhật lên Facebook */}
                <div className="pt-2 flex items-center justify-between">
                  <div className="space-y-0.5 pr-2">
                    <div className="text-xs font-bold text-white">Tự động gắn lên Facebook</div>
                    <div className="text-[10px] text-slate-400">Gắn ảnh ngay sau khi Muse render xong qua Meta API (cờ ẩn).</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAutoApplyFacebook(!autoApplyFacebook)}
                    className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors shrink-0 cursor-pointer ${
                      autoApplyFacebook ? 'bg-emerald-500' : 'bg-black/30 shadow-inner border border-white/5'
                    }`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${autoApplyFacebook ? 'translate-x-5' : 'translate-x-1'}`} />
                  </button>
                </div>

                {/** Switch 2: Chèn tên Fanpage vào Artwork */}
                <div className="pt-2 flex items-center justify-between">
                  <div className="space-y-0.5 pr-2">
                    <div className="text-xs font-bold text-white">Chèn Tên Page Typography</div>
                    <div className="text-[10px] text-slate-400">Yêu cầu Muse vẽ tên Fanpage dạng chữ nổi bật vào ảnh.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIncludePageNameText(!includePageNameText)}
                    className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors shrink-0 cursor-pointer ${
                      includePageNameText ? 'bg-emerald-500' : 'bg-black/30 shadow-inner border border-white/5'
                    }`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${includePageNameText ? 'translate-x-5' : 'translate-x-1'}`} />
                  </button>
                </div>

                {/** Tóm tắt phạm vi */}
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-1.5 text-xs text-emerald-300">
                  <div className="flex items-center gap-1.5 font-bold text-emerald-400">
                    <span className="material-symbols-outlined text-sm">verified</span>
                    <span>Phạm vi áp dụng:</span>
                  </div>
                  <div>
                    {selectedPageIds.length > 0
                      ? `Đang chọn ${selectedPageIds.length} Fanpage cụ thể.`
                      : `Áp dụng cho toàn bộ ${filteredPages.length} Fanpage theo bộ lọc hiện tại.`}
                  </div>
                </div>

                {/** Nút Bắt Đầu Gửi Hàng Đợi */}
                <button
                  type="button"
                  onClick={handleQueueBrandingSubmit}
                  disabled={isSubmittingQueue || (selectedPageIds.length === 0 && filteredPages.length === 0)}
                  className="w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:opacity-90 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isSubmittingQueue ? (
                    <span className="material-symbols-outlined animate-spin text-sm">sync</span>
                  ) : (
                    <span className="material-symbols-outlined text-sm">rocket_launch</span>
                  )}
                  <span>
                    {isSubmittingQueue
                      ? 'Đang gửi vào hàng đợi...'
                      : `Bắt Đầu Đưa ${selectedPageIds.length > 0 ? selectedPageIds.length : filteredPages.length} Page Vào Hàng Đợi`}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/** =========================================================================
       * TAB 3: HÀNG ĐỢI & THƯ VIỆN ẢNH ĐÃ TẠO (LIVE STATUS & MOCKUP)
       * ========================================================================= */}
      {activeTab === 3 && (
        <div className="space-y-6 animate-in fade-in duration-200">
          {/** Khung Trạng Thái Worker & Hàng Đợi */}
          <div className="bg-fb-surface rounded-2xl shadow-lg border border-fb-surface-hover/50 p-4 sm:p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-fb-surface-hover/40">
              <div className="flex items-center gap-2.5">
                <span className="p-2 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <span className="material-symbols-outlined text-lg">smart_toy</span>
                </span>
                <div>
                  <h3 className="text-sm font-bold text-white">Trạng Thái Muse Worker (Chrome RPA)</h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Worker chạy trên máy tính kết nối cổng Chrome Remote Debugging 9245 (hoặc 9222).
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-mono">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  Cổng: 9245 / 9222
                </span>
              </div>
            </div>

            {/** Thống kê chi tiết Queue */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-xl bg-slate-900/40 border border-slate-700/60 text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Chờ xử lý (Pending)</div>
                <div className="text-xl font-bold text-amber-400 mt-0.5">
                  {queueStatus?.queue?.pending || 0}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/40 border border-slate-700/60 text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Đang vẽ (Processing)</div>
                <div className="text-xl font-bold text-cyan-400 mt-0.5">
                  {queueStatus?.queue?.processing || 0}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/40 border border-slate-700/60 text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Đã hoàn thành</div>
                <div className="text-xl font-bold text-emerald-400 mt-0.5">
                  {queueStatus?.queue?.completed || 0}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-900/40 border border-slate-700/60 text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Lỗi (Failed)</div>
                <div className="text-xl font-bold text-rose-400 mt-0.5">
                  {queueStatus?.queue?.failed || 0}
                </div>
              </div>
            </div>
          </div>

          {/** Lưới Xem Trước Mockup Fanpage Facebook Chuẩn Thực Tế */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span className="material-symbols-outlined text-emerald-400">preview</span>
                <span>Thư Viện Nhận Diện Fanpage (Mockup Facebook Chuẩn)</span>
              </h3>
              <div className="text-xs text-slate-400">
                Hiển thị các Fanpage trong hệ thống kèm Avatar 1:1 và Cover 16:9
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {pages.map(page => {
                const hasAvatar = !!page.brandingAvatarUrl;
                const hasCover = !!page.brandingCoverUrl;
                const isApplying = isApplyingFacebook === page.id;

                return (
                  <div
                    key={page.id}
                    className="bg-fb-surface rounded-2xl border border-fb-surface-hover/60 overflow-hidden shadow-lg flex flex-col justify-between transition-all hover:border-slate-600"
                  >
                    <div>
                      {/** Khung Mockup Cover Banner 16:9 */}
                      <div className="relative aspect-video bg-slate-900 overflow-hidden border-b border-fb-surface-hover/40">
                        {page.brandingCoverUrl ? (
                          <img
                            src={page.brandingCoverUrl}
                            alt="Cover"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 text-xs p-4 text-center">
                            <span className="material-symbols-outlined text-3xl mb-1 text-slate-600">panorama</span>
                            <span>Chưa có ảnh bìa tùy chỉnh</span>
                            <span className="text-[10px] text-slate-600 mt-0.5">Sẵn sàng để Muse vẽ</span>
                          </div>
                        )}

                        {/** Badge BM nổi góc phải */}
                        {page.businessName && (
                          <span className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-slate-950/80 backdrop-blur-md text-slate-300 text-[10px] font-bold border border-white/10">
                            {page.businessName}
                          </span>
                        )}

                        {/** Avatar 1:1 đè góc dưới trái */}
                        <div className="absolute -bottom-4 left-4 w-14 h-14 rounded-full border-3 border-fb-surface overflow-hidden bg-slate-800 shadow-xl">
                          {page.brandingAvatarUrl || page.avatar ? (
                            <img
                              src={page.brandingAvatarUrl || page.avatar}
                              alt="Avatar"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-400 font-bold text-sm">
                              {page.name.slice(0, 2).toUpperCase()}
                            </div>
                          )}
                        </div>
                      </div>

                      {/** Thông tin Fanpage bên dưới */}
                      <div className="pt-6 p-4 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="font-bold text-white text-sm truncate" title={page.name}>
                            {page.name}
                          </h4>
                          {page.brandingStatus === 'PENDING' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0">
                              Chờ Muse vẽ
                            </span>
                          )}
                          {page.brandingStatus === 'PROCESSING' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shrink-0 animate-pulse">
                              Đang vẽ...
                            </span>
                          )}
                          {page.brandingStatus === 'COMPLETED' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
                              Đã hoàn thành
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-slate-400 flex items-center justify-between">
                          <span className="font-mono">ID: {page.fb_page_id || page.id}</span>
                          <span className="text-emerald-400/90 font-medium">{page.primarySourceWeb || 'history.imsb.info'}</span>
                        </div>
                      </div>
                    </div>

                    {/** Thanh Thao Tác Dưới Cùng */}
                    <div className="p-3 bg-slate-900/30 border-t border-fb-surface-hover/40 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        {page.brandingCoverUrl && (
                          <a
                            href={page.brandingCoverUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1.5 hover:bg-fb-surface-hover rounded-lg text-slate-400 hover:text-white transition-colors"
                            title="Xem Ảnh Bìa gốc"
                          >
                            <span className="material-symbols-outlined text-sm">open_in_new</span>
                          </a>
                        )}
                        {page.brandingStatus && page.brandingStatus !== 'NONE' && (
                          <button
                            type="button"
                            onClick={() => handleResetJob(page.id)}
                            className="p-1.5 hover:bg-fb-surface-hover rounded-lg text-slate-400 hover:text-rose-400 transition-colors"
                            title="Reset trạng thái job"
                          >
                            <span className="material-symbols-outlined text-sm">restart_alt</span>
                          </button>
                        )}
                      </div>

                      {(hasAvatar || hasCover) ? (
                        <button
                          type="button"
                          onClick={() => handleApplySinglePageFacebook(page)}
                          disabled={isApplying}
                          className="px-3 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 text-xs font-bold rounded-xl flex items-center gap-1 transition-all cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-sm">
                            {isApplying ? 'sync' : 'publish'}
                          </span>
                          <span>{isApplying ? 'Đang gắn...' : 'Gắn lên Facebook'}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPageIds([page.id]);
                            setActiveTab(2);
                          }}
                          className="px-3 py-1.5 bg-fb-surface-hover hover:bg-fb-surface-hover/80 text-fb-text text-xs font-bold rounded-xl transition-colors cursor-pointer"
                        >
                          Tạo ảnh cho Page này
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
