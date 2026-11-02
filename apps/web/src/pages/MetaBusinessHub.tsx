import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useZTTeamFacebookStore } from '../stores/facebookStore';
import { useUIStore } from '../stores/uiStore';
import { ztteam_decodeHtmlEntity } from '../utils/stringUtils';
import api from '../services/api';

/**
 * Trang Quan Ly Doanh Nghiep (Meta Business Hub)
 * Quan ly tap trung cac Business Manager (BM), Meta Apps, System Users va Fanpages truc thuoc.
 * Tuan thu nghiem ngat Style Guidelines: khong dung mau hong/tim, dung chuan component cua FacebookPageSettings.
 */
export default function MetaBusinessHub() {
  const navigate = useNavigate();
  const { businesses, ztteam_fetchBusinesses, ztteam_connectBMToken, ztteam_deleteAccount } = useZTTeamFacebookStore();
  const { ztteam_showToast, ztteam_showConfirm } = useUIStore();

  const [isLoadingData, setIsLoadingData] = useState<boolean>(false);
  const [isConnectModalOpen, setIsConnectModalOpen] = useState<boolean>(false);
  const [tokenInput, setTokenInput] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null);

  /** Load danh sach BM khi mo trang */
  useEffect(() => {
    ztteam_loadData();
  }, []);

  const ztteam_loadData = async () => {
    setIsLoadingData(true);
    try {
      await ztteam_fetchBusinesses();
    } catch (e: any) {
      ztteam_showToast('Không thể tải danh sách Doanh Nghiệp', 'error');
    } finally {
      setIsLoadingData(false);
    }
  };

  /** Xu ly submit Token BM */
  const handleConnectToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) {
      ztteam_showToast('Vui lòng dán chuỗi Token Meta Business', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await ztteam_connectBMToken(tokenInput.trim());
      ztteam_showToast(res?.message || 'Kết nối Doanh Nghiệp BM thành công!', 'success');
      setTokenInput('');
      setIsConnectModalOpen(false);
      await ztteam_loadData();
    } catch (err: any) {
      ztteam_showToast(err.message || 'Lỗi khi kết nối Token BM', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Xu ly dong bo lai Fanpage cho 1 BM */
  const handleSyncAccount = async (accountId: string, accountName: string) => {
    try {
      setSyncingAccountId(accountId);
      const res = await api.post(`/facebook/pages/${accountId}/fetch`);
      if (res.data) {
        ztteam_showToast(`Đã đồng bộ lại danh sách Fanpage cho "${accountName}" thành công!`, 'success');
        await ztteam_loadData();
      }
    } catch (err: any) {
      ztteam_showToast(err.response?.data?.message || err.message || 'Lỗi khi đồng bộ Fanpage', 'error');
    } finally {
      setSyncingAccountId(null);
    }
  };

  /** Xu ly xoa BM / Huy ket noi */
  const handleDeleteBusiness = async (accountId: string, businessName: string) => {
    const confirm = await ztteam_showConfirm(
      'Hủy Kết Nối Doanh Nghiệp',
      `Bạn có chắc chắn muốn hủy kết nối Doanh Nghiệp "${businessName}"? Toàn bộ Fanpage thuộc BM này sẽ được cập nhật trạng thái tương ứng.`
    );
    if (!confirm) return;

    try {
      await ztteam_deleteAccount(accountId);
      ztteam_showToast(`Đã hủy kết nối Doanh Nghiệp "${businessName}" thành công!`, 'success');
      await ztteam_loadData();
    } catch (e: any) {
      ztteam_showToast(e.message || 'Lỗi khi xóa Doanh Nghiệp', 'error');
    }
  };

  /** Tinh toan thong ke */
  const totalBMCount = businesses.filter(b => b.accountType === 'SYSTEM_USER').length;
  const totalPagesInBM = businesses.reduce((acc, b) => acc + (b.pagesCount || 0), 0);
  const uniqueAppsCount = new Set(businesses.map(b => b.appId).filter(Boolean)).size;

  return (
    <div className="w-full space-y-6">
      {/** 1. Header Banner */}
      <div className="bg-fb-surface rounded-2xl shadow-lg p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border border-slate-700/40">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-500/15 text-blue-400 flex items-center justify-center font-bold">
              <span className="material-symbols-outlined text-xl">domain</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-fb-text tracking-tight">
              Quản Lý Doanh Nghiệp (Meta Business Hub)
            </h2>
          </div>
          <p className="text-sm font-medium text-fb-text-muted mt-1.5">
            Quản trị tập trung các Business Manager (Multi-BM), Meta Apps, System Users và Fanpages trực thuộc.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <Link
            to="/meta-bm-guide"
            className="px-3.5 py-2.5 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 border border-blue-500/30 rounded-full text-xs sm:text-sm font-bold flex items-center gap-1.5 transition-colors"
            title="Xem hướng dẫn chi tiết tạo Token BM và cấp quyền 6 bước"
          >
            <span className="material-symbols-outlined text-base">menu_book</span>
            <span>Hướng Dẫn Token</span>
          </Link>

          <button
            onClick={ztteam_loadData}
            disabled={isLoadingData}
            className="px-3.5 py-2.5 bg-fb-surface-hover hover:bg-fb-surface-hover/80 text-fb-text rounded-full text-xs sm:text-sm font-bold flex items-center gap-1.5 transition-colors"
            title="Tải lại danh sách"
          >
            <span className={`material-symbols-outlined text-base ${isLoadingData ? 'animate-spin' : ''}`}>refresh</span>
            <span>Tải Lại</span>
          </button>

          <button
            onClick={() => setIsConnectModalOpen(true)}
            className="bg-gradient-to-r from-fb-blue to-cyan-500 hover:opacity-90 text-white px-5 py-2.5 rounded-full text-xs sm:text-sm font-bold transition-all shadow-lg shadow-blue-500/25 flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-lg">add_circle</span>
            <span>Thêm Token BM / System User</span>
          </button>
        </div>
      </div>

      {/** 2. Summary Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        {/** Card 1: Tổng Doanh Nghiệp BM */}
        <div className="bg-gradient-to-br from-fb-surface via-fb-surface to-blue-950/30 rounded-2xl p-4 shadow-lg flex flex-col justify-between border border-blue-500/20">
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="text-[10px] sm:text-xs font-black text-blue-400 uppercase tracking-wider">Doanh Nghiệp (BM)</p>
              <h3 className="text-2xl sm:text-3xl font-black text-fb-text mt-1">{totalBMCount || businesses.length}</h3>
            </div>
            <div className="w-10 h-10 flex items-center justify-center bg-blue-500/15 text-blue-400 rounded-xl">
              <span className="material-symbols-outlined text-2xl">corporate_fare</span>
            </div>
          </div>
          <p className="text-[11px] text-fb-text-muted">Đang quản trị độc lập</p>
        </div>

        {/** Card 2: Meta Apps */}
        <div className="bg-gradient-to-br from-fb-surface via-fb-surface to-emerald-950/30 rounded-2xl p-4 shadow-lg flex flex-col justify-between border border-emerald-500/20">
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="text-[10px] sm:text-xs font-black text-emerald-400 uppercase tracking-wider">Meta Apps Liên Kết</p>
              <h3 className="text-2xl sm:text-3xl font-black text-emerald-400 mt-1">{uniqueAppsCount || 1}</h3>
            </div>
            <div className="w-10 h-10 flex items-center justify-center bg-emerald-500/15 text-emerald-400 rounded-xl">
              <span className="material-symbols-outlined text-2xl">apps</span>
            </div>
          </div>
          <p className="text-[11px] text-fb-text-muted">Chia tải Rate Limit an toàn</p>
        </div>

        {/** Card 3: Fanpages trong BM */}
        <div className="bg-gradient-to-br from-fb-surface via-fb-surface to-amber-950/30 rounded-2xl p-4 shadow-lg flex flex-col justify-between border border-amber-500/20">
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="text-[10px] sm:text-xs font-black text-amber-400 uppercase tracking-wider">Fanpages Trực Thuộc</p>
              <h3 className="text-2xl sm:text-3xl font-black text-amber-400 mt-1">{totalPagesInBM}</h3>
            </div>
            <div className="w-10 h-10 flex items-center justify-center bg-amber-500/15 text-amber-400 rounded-xl">
              <span className="material-symbols-outlined text-2xl">pages</span>
            </div>
          </div>
          <p className="text-[11px] text-fb-text-muted">Sẵn sàng xuất bản Reels</p>
        </div>

        {/** Card 4: Tình Trạng Token */}
        <div className="bg-gradient-to-br from-fb-surface via-fb-surface to-cyan-950/30 rounded-2xl p-4 shadow-lg flex flex-col justify-between border border-cyan-500/20">
          <div className="flex justify-between items-start mb-2">
            <div>
              <p className="text-[10px] sm:text-xs font-black text-cyan-400 uppercase tracking-wider">Thời Hạn Token</p>
              <h3 className="text-lg sm:text-xl font-black text-cyan-400 mt-2">VĨNH VIỄN</h3>
            </div>
            <div className="w-10 h-10 flex items-center justify-center bg-cyan-500/15 text-cyan-400 rounded-xl">
              <span className="material-symbols-outlined text-2xl">all_inclusive</span>
            </div>
          </div>
          <p className="text-[11px] text-fb-text-muted">Never Expire / 0 Checkpoint</p>
        </div>
      </div>

      {/** 3. Danh Sach Cac Doanh Nghiep (BM Cards) */}
      <div className="space-y-5">
        {businesses.length === 0 ? (
          <div className="bg-fb-surface rounded-2xl p-12 text-center border border-slate-700/40">
            <span className="material-symbols-outlined text-5xl text-fb-text-muted opacity-40 mb-3">domain_disabled</span>
            <h4 className="text-lg font-bold text-fb-text">Chưa có Doanh Nghiệp (BM) nào kết nối</h4>
            <p className="text-xs text-fb-text-muted mt-1 max-w-md mx-auto">
              Hãy bấm "Thêm Token BM / System User" ở trên và dán chuỗi token từ Business Manager để bắt đầu tự động hóa vĩnh viễn.
            </p>
            <button
              onClick={() => setIsConnectModalOpen(true)}
              className="mt-4 px-5 py-2.5 bg-fb-blue hover:bg-fb-blue-hover text-white rounded-full font-bold text-xs shadow-md transition-all inline-flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-base">add</span>
              <span>Kết Nối Token BM Đầu Tiên</span>
            </button>
          </div>
        ) : (
          businesses.map((biz: any) => {
            const isSystemUser = biz.accountType === 'SYSTEM_USER';
            const isSyncing = syncingAccountId === biz.id;

            return (
              <div key={biz.id} className="bg-fb-surface rounded-2xl shadow-lg border border-slate-700/50 overflow-hidden">
                {/** Header Card của BM */}
                <div className="p-5 bg-fb-surface-hover/50 border-b border-slate-700/40 space-y-4">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-start gap-3.5">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-500 text-white flex items-center justify-center font-black text-xl shrink-0 shadow-md">
                        <span className="material-symbols-outlined text-2xl">corporate_fare</span>
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-black text-fb-text tracking-tight">{biz.businessName || 'Doanh Nghiệp BM'}</h3>
                          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-500/15 text-blue-400 border border-blue-500/30">
                            {isSystemUser ? '⚡ BM System User' : '👤 Tài Khoản Cá Nhân'}
                          </span>
                          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            <span>{biz.tokenExpiry === 'NEVER' ? 'Vĩnh Viễn (Never Expire)' : 'Đang Hoạt Động'}</span>
                          </span>
                          {biz.businessId && (
                            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">
                              BM ID: {biz.businessId}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/** Action buttons tren Header BM */}
                    <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                      <button
                        onClick={() => handleSyncAccount(biz.id, biz.businessName || biz.name)}
                        disabled={isSyncing}
                        className="px-3.5 py-2 bg-fb-surface-hover hover:bg-slate-700 text-fb-text rounded-full text-xs font-bold flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer shadow-xs"
                        title="Quét tìm Fanpage mới được gán cho tài khoản này"
                      >
                        <span className={`material-symbols-outlined text-sm ${isSyncing ? 'animate-spin text-blue-400' : ''}`}>sync</span>
                        <span>Đồng Bộ Fanpage</span>
                      </button>

                      <button
                        onClick={() => handleDeleteBusiness(biz.id, biz.businessName || biz.name)}
                        className="px-3.5 py-2 bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white rounded-full text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer"
                        title="Hủy kết nối Doanh Nghiệp này"
                      >
                        <span className="material-symbols-outlined text-sm">delete</span>
                        <span>Hủy BM</span>
                      </button>
                    </div>
                  </div>

                  {/** 4 Khối thông tin chi tiết đầy đủ: Tên tài khoản, User ID, App ID, Số lượng Fanpage */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                    {/** 1. Tên tài khoản */}
                    <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-700/60 flex flex-col justify-between">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[15px] text-blue-400">person</span>
                        <span>Tên Tài Khoản</span>
                      </div>
                      <div className="text-xs sm:text-sm font-bold text-white mt-1.5 truncate" title={biz.name || biz.businessName}>
                        {biz.name || biz.businessName || 'Không tên'}
                      </div>
                    </div>

                    {/** 2. User ID */}
                    <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-700/60 flex flex-col justify-between">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[15px] text-cyan-400">badge</span>
                        <span>User ID (Facebook)</span>
                      </div>
                      <div className="text-xs sm:text-sm font-mono font-bold text-cyan-300 mt-1.5 flex items-center justify-between gap-1">
                        <span className="truncate">{biz.fbUserId || 'N/A'}</span>
                        {biz.fbUserId && (
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(biz.fbUserId);
                              ztteam_showToast('Đã sao chép User ID!', 'success');
                            }}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors cursor-pointer shrink-0"
                            title="Sao chép User ID"
                          >
                            <span className="material-symbols-outlined text-[15px]">content_copy</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/** 3. App ID */}
                    <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-700/60 flex flex-col justify-between">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[15px] text-emerald-400">apps</span>
                        <span>App ID</span>
                      </div>
                      <div className="text-xs sm:text-sm font-mono font-bold text-emerald-400 mt-1.5 flex items-center justify-between gap-1">
                        <span className="truncate" title={biz.appName ? `${biz.appId} (${biz.appName})` : biz.appId}>
                          {biz.appId || 'N/A'} {biz.appName ? <span className="text-[11px] font-sans font-normal text-slate-400">({biz.appName})</span> : null}
                        </span>
                        {biz.appId && (
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(biz.appId);
                              ztteam_showToast('Đã sao chép App ID!', 'success');
                            }}
                            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors cursor-pointer shrink-0"
                            title="Sao chép App ID"
                          >
                            <span className="material-symbols-outlined text-[15px]">content_copy</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/** 4. Số lượng Fanpage */}
                    <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-700/60 flex flex-col justify-between">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[15px] text-amber-400">flag</span>
                        <span>Số Lượng Fanpage</span>
                      </div>
                      <div className="text-xs sm:text-sm font-black text-amber-400 mt-1.5 flex items-center gap-1.5">
                        <span className="text-base sm:text-lg">{biz.pages?.length || biz.pagesCount || 0}</span>
                        <span className="text-[11px] font-normal text-slate-400">Fanpage trực thuộc</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/** Body: Danh sach Fanpage thuoc BM */}
                <div className="p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-black uppercase text-slate-400 tracking-wider flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm text-blue-400">pages</span>
                      <span>Fanpage Trực Thuộc Quản Lý ({biz.pages?.length || 0} Pages)</span>
                    </h4>
                    <span className="text-xs text-fb-text-muted">Được gán quyền tạo Reel &amp; xuất bản nội dung</span>
                  </div>

                  {(!biz.pages || biz.pages.length === 0) ? (
                    <div className="p-6 rounded-xl bg-slate-900/40 text-center text-fb-text-muted text-xs">
                      Chưa có Fanpage nào được gán cho System User này trong Meta Business Manager.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {biz.pages.map((p: any) => (
                        <div key={p.id} className="p-3.5 rounded-xl bg-fb-surface-hover/40 border border-slate-700/40 flex items-center justify-between gap-3 hover:bg-fb-surface-hover/70 transition-colors">
                          <div className="flex items-center gap-3 min-w-0">
                            {p.avatar ? (
                              <img src={p.avatar} alt={p.name} className="w-10 h-10 rounded-xl object-cover shrink-0 bg-slate-900" />
                            ) : (
                              <div className="w-10 h-10 rounded-xl bg-blue-600/30 text-blue-400 flex items-center justify-center font-bold shrink-0">
                                <span className="material-symbols-outlined text-lg">pages</span>
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="font-bold text-sm text-fb-text truncate">{ztteam_decodeHtmlEntity(p.name)}</p>
                              <div className="flex items-center gap-1.5 text-[11px] text-fb-text-muted mt-0.5">
                                <span>{(p.followersCount || 0).toLocaleString()} sub</span>
                                <span>•</span>
                                <span className="truncate">ID: {p.id}</span>
                              </div>
                            </div>
                          </div>

                          <button
                            onClick={() => navigate(`/facebook/pages/${p.id}/settings`)}
                            className="px-2.5 py-1 bg-blue-500/10 hover:bg-blue-500 text-blue-400 hover:text-white rounded-lg text-xs font-bold transition-colors shrink-0 flex items-center gap-1"
                            title="Mở cấu hình Fanpage này"
                          >
                            <span>Cài đặt</span>
                            <span className="material-symbols-outlined text-xs">arrow_forward</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/** 4. Modal Ket Noi Token BM */}
      {isConnectModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-fb-surface w-full max-w-xl rounded-3xl p-6 shadow-2xl border border-slate-700/60 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-700/40">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-500/15 text-blue-400 flex items-center justify-center font-bold">
                  <span className="material-symbols-outlined text-xl">vpn_key</span>
                </div>
                <div>
                  <h4 className="text-base font-black text-fb-text">Kết Nối Token Meta Business (BM)</h4>
                  <p className="text-xs text-fb-text-muted">Nhận diện tự động BM, App, System User và Fanpage</p>
                </div>
              </div>
              <button
                onClick={() => setIsConnectModalOpen(false)}
                className="w-8 h-8 rounded-full bg-fb-surface-hover text-fb-text-muted hover:text-white flex items-center justify-center transition-colors"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <form onSubmit={handleConnectToken} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-fb-text mb-1.5">
                  Dán chuỗi Token System User (EAAT...):
                </label>
                <textarea
                  rows={4}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Dán chuỗi token bắt đầu bằng EAAT... vào đây"
                  className="w-full px-3.5 py-2.5 bg-fb-surface-hover border border-slate-700/60 rounded-xl text-xs text-fb-text focus:outline-none focus:border-fb-blue transition-colors font-mono"
                  disabled={isSubmitting}
                />
              </div>

              <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300 space-y-1">
                <p className="font-bold flex items-center gap-1 text-blue-400">
                  <span className="material-symbols-outlined text-sm">verified</span>
                  Cơ chế tự động 100%:
                </p>
                <p>• Hệ thống sẽ tự động xác định Doanh Nghiệp (BM), Meta App và các Fanpage đã cấp quyền.</p>
                <p>• Token System User có thời hạn <b>VĨNH VIỄN</b>, không bao giờ lo checkpoint hay hết hạn sau 60 ngày.</p>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsConnectModalOpen(false)}
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-fb-surface-hover hover:bg-slate-700 text-fb-text rounded-full text-xs font-bold transition-colors"
                >
                  Hủy Bỏ
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !tokenInput.trim()}
                  className="px-5 py-2 bg-gradient-to-r from-fb-blue to-cyan-500 hover:opacity-90 text-white rounded-full text-xs font-bold transition-all shadow-md shadow-blue-500/25 flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <span className="material-symbols-outlined text-sm animate-spin">sync</span>
                      <span>Đang Phân Tích &amp; Kết Nối...</span>
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      <span>Xác Thực &amp; Đồng Bộ BM</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
