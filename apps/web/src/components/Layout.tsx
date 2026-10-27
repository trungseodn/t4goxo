import React, { useState, useEffect } from 'react';
import { useZTTeamAuthStore } from '../stores/authStore';
import { useZTTeamFacebookStore } from '../stores/facebookStore';
import { Outlet, Link, useLocation } from 'react-router-dom';
import UIProvider from './UIProvider';
import { useUIStore } from '../stores/uiStore';
import { ztteam_decodeHtmlEntity } from '../utils/stringUtils';
import api from '../services/api';
import ZTTeamRealtimeWidget from './RealtimeWidget';

interface ZTTeamSangTaoQuotaData {
    email?: string;
    quotaRemaining: number;
    chargeSource?: string;
    concurrency?: number;
    capReason?: string;
    updatedAt?: string;
}

/** Helper to check if a nav item is active */
function ztteam_isActive(pathname: string, path: string): boolean {
    if (path === '/') return pathname === '/';
    if (path === '/facebook') {
        return pathname === '/facebook' || pathname.startsWith('/facebook/pages');
    }
    return pathname.startsWith(path);
}

export default function Layout() {
    const { user, ztteam_logout } = useZTTeamAuthStore();
    const { pages, ztteam_fetchPagesFromDB } = useZTTeamFacebookStore();
    const { isDarkMode, ztteam_toggleDarkMode } = useUIStore();
    const location = useLocation();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isFbSubmenuOpen, setIsFbSubmenuOpen] = useState(true);
    const [sangtaoQuota, setSangtaoQuota] = useState<ZTTeamSangTaoQuotaData | null>(null);
    const [showSangtaoMenu, setShowSangtaoMenu] = useState(false);
    const [isRefreshingQuota, setIsRefreshingQuota] = useState(false);

    /** Lấy thông tin tài khoản và hạn mức SangTao.ai */
    const ztteam_fetchSangTaoQuota = async () => {
        setIsRefreshingQuota(true);
        try {
            const res = await api.get('/story-test/sangtao-quota');
            if (res.data?.success && res.data?.data) {
                setSangtaoQuota(res.data.data);
            }
        } catch (e) {
            /** Bỏ qua lỗi mạng */
        } finally {
            setIsRefreshingQuota(false);
        }
    };

    /** Fetch Facebook pages và SangTao quota on mount */
    useEffect(() => {
        ztteam_fetchPagesFromDB();
        ztteam_fetchSangTaoQuota();
    }, []);

    /** Auto-close mobile sidebar when route changes */
    useEffect(() => {
        setIsMobileMenuOpen(false);
    }, [location.pathname]);

    const handleLogout = (e: React.MouseEvent) => {
        e.preventDefault();
        ztteam_logout();
    };

    /** Sidebar navigation items */
    let navItems = [
        { to: '/', icon: 'dashboard', label: 'Dashboard' },
        { to: '/facebook', icon: 'qr_code_2', label: 'Facebook Pages', hasSubmenu: true },
        { to: '/facebook/branding-muse', icon: 'palette', label: 'Tạo Ảnh Bìa & Avatar' },
        { to: '/facebook/business-hub', icon: 'domain', label: 'Quản Lý BM & App' },
        { to: '/meta-bm-guide', icon: 'menu_book', label: 'HD Tạo Token BM' },
        { to: '/crawl-sources', icon: 'language', label: 'Website' },
        { to: '/ai-factory', icon: 'auto_awesome', label: 'AI Factory' },
        { to: '/story-test', icon: 'auto_stories', label: 'Story Studio (Test)' },
        { to: '/statistics', icon: 'bar_chart', label: 'Thống Kê' },
        { to: '/google-analytics', icon: 'insights', label: 'Google Analytics' },
    ];

    if (user?.role === 'ADMIN') {
        navItems.push(
            { to: '/users', icon: 'manage_accounts', label: 'User Management' },
            { to: '/settings', icon: 'settings', label: 'System Settings' }
        );
    }

    return (
        <>
            <UIProvider />

            {/* Mobile Backdrop Overlay */}
            {isMobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-40 lg:hidden transition-opacity duration-300"
                    onClick={() => setIsMobileMenuOpen(false)}
                    aria-hidden="true"
                />
            )}

            {/* Sidebar */}
            <aside className={`fixed left-0 top-0 h-full w-[260px] bg-fb-surface flex flex-col shadow-2xl z-50 transition-transform duration-300 ease-in-out ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
                <div className="p-5 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 via-fb-blue to-cyan-400 flex items-center justify-center text-white font-black text-xl shadow-lg shadow-blue-500/30">
                            f
                        </div>
                        <div>
                            <h1 className="text-base font-black text-fb-text tracking-wide leading-tight">CreatorPro AI</h1>
                            <p className="text-xs font-medium text-fb-text-muted">Tự Động Hóa Facebook</p>
                        </div>
                    </div>
                    {/* Close button on mobile */}
                    <button
                        onClick={() => setIsMobileMenuOpen(false)}
                        className="lg:hidden text-fb-text-muted hover:text-fb-text p-1 rounded-full transition-colors"
                        title="Đóng menu"
                    >
                        <span className="material-symbols-outlined text-xl">close</span>
                    </button>
                </div>

                {/* Quick Action Button */}
                <div className="p-4 pt-1">
                    <Link to="/ai-factory" className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-fb-blue to-cyan-500 hover:from-fb-blue-hover hover:to-cyan-600 text-white py-2.5 px-5 rounded-full font-bold text-sm transition-all duration-200 shadow-lg shadow-blue-500/25">
                        <span className="material-symbols-outlined text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                        <span>AI Factory</span>
                    </Link>
                </div>

                <nav className="flex-1 px-3 py-2 overflow-y-auto space-y-1">
                    {navItems.map(item => {
                        const active = ztteam_isActive(location.pathname, item.to);

                        if (item.hasSubmenu) {
                            return (
                                <div key={item.to} className="space-y-1">
                                    <div className="flex items-center justify-between">
                                        <Link
                                            to={item.to}
                                            onClick={() => setIsMobileMenuOpen(false)}
                                            className={`flex-grow flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors duration-200 text-sm ${active
                                                ? 'bg-blue-500/15 text-blue-400 font-bold'
                                                : 'text-fb-text-muted hover:bg-fb-surface-hover hover:text-fb-text font-semibold'
                                                }`}
                                        >
                                            <span className="material-symbols-outlined text-xl">{item.icon}</span>
                                            <span>{item.label}</span>
                                        </Link>
                                        <button
                                            type="button"
                                            onClick={() => setIsFbSubmenuOpen(!isFbSubmenuOpen)}
                                            className="w-8 h-8 flex items-center justify-center rounded-lg text-fb-text-muted hover:text-fb-text hover:bg-fb-surface-hover transition-colors p-0"
                                            title="Thu/Mở danh sách Fanpage"
                                        >
                                            <span className={`material-symbols-outlined text-lg transition-transform duration-200 ${isFbSubmenuOpen ? 'rotate-180' : ''}`}>
                                                expand_more
                                            </span>
                                        </button>
                                    </div>

                                    {/* Sub-menu for Facebook Pages */}
                                    {isFbSubmenuOpen && (
                                        <div className="pl-6 space-y-1 border-l-2 border-fb-surface-hover ml-6 py-1">
                                            {pages.filter(page => page.isActive !== false).map((page) => {
                                                const reportPath = `/facebook/pages/${page.id}/report`;
                                                const isReportActive = location.pathname === reportPath;
                                                return (
                                                    <Link
                                                        key={page.id}
                                                        to={reportPath}
                                                        onClick={() => setIsMobileMenuOpen(false)}
                                                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors duration-150 ${isReportActive
                                                            ? 'bg-blue-500/15 text-blue-400 font-bold'
                                                            : 'text-fb-text-muted hover:bg-fb-surface-hover hover:text-fb-text'
                                                            }`}
                                                        title={`Báo cáo chi tiết ${ztteam_decodeHtmlEntity(page.name)}`}
                                                    >
                                                        <span className="material-symbols-outlined text-base text-blue-500 shrink-0">bar_chart</span>
                                                        <span className="truncate">{ztteam_decodeHtmlEntity(page.name)}</span>
                                                    </Link>
                                                );
                                            })}
                                            {pages.filter(page => page.isActive !== false).length === 0 && (
                                                <div className="px-3 py-1.5 text-xs text-fb-text-muted italic">
                                                    Chưa có Fanpage nào
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        }

                        return (
                            <Link
                                key={item.to}
                                to={item.to}
                                onClick={() => setIsMobileMenuOpen(false)}
                                className={`flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors duration-200 text-sm ${active
                                    ? 'bg-blue-500/15 text-blue-400 font-bold'
                                    : 'text-fb-text-muted hover:bg-fb-surface-hover hover:text-fb-text font-semibold'
                                    }`}
                            >
                                <span className="material-symbols-outlined text-xl">{item.icon}</span>
                                <span>{item.label}</span>
                            </Link>
                        );
                    })}
                </nav>

                <div className="mt-auto p-3">
                    <a className="flex w-full items-center gap-3 px-4 py-2.5 text-rose-500 hover:bg-rose-500/10 hover:text-rose-400 transition-colors cursor-pointer rounded-xl font-bold" onClick={handleLogout}>
                        <span className="material-symbols-outlined text-xl">logout</span>
                        <span className="text-sm">Đăng xuất</span>
                    </a>
                </div>
            </aside>

            {/* Header */}
            <header className="fixed top-0 right-0 w-full lg:w-[calc(100%-260px)] h-16 bg-fb-surface px-4 sm:px-6 flex items-center justify-between shrink-0 z-30 shadow-sm">
                <div className="flex items-center gap-3">
                    <button onClick={() => setIsMobileMenuOpen(true)} className="lg:hidden text-fb-text p-2 rounded-full hover:bg-fb-surface-hover transition-colors">
                        <span className="material-symbols-outlined text-2xl">menu</span>
                    </button>
                    <div className="relative hidden sm:block w-64 md:w-80">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-fb-text-muted text-xl">search</span>
                        <input type="text" placeholder="Tìm kiếm trên CreatorPro..." className="w-full pl-10 pr-4 py-2 bg-fb-surface-hover text-fb-text placeholder:text-fb-text-muted rounded-full text-sm font-medium border-none focus:outline-none focus:ring-2 focus:ring-fb-blue transition-all" />
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/** Google Analytics 4 Realtime Online Badge */}
                    <ZTTeamRealtimeWidget />

                    {/** SangTao.ai Quota Compact Badge */}
                    <div className="relative">
                        <button
                            onClick={() => setShowSangtaoMenu(!showSangtaoMenu)}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-fb-surface-hover hover:bg-slate-800 text-fb-text border border-slate-700/60 transition-all text-xs font-semibold shadow-sm cursor-pointer select-none"
                            title="Hạn mức tài khoản SangTao.ai"
                        >
                            <span className="material-symbols-outlined text-sm text-cyan-400">magic_button</span>
                            <span className="hidden sm:inline text-fb-text-muted font-mono">SangTao:</span>
                            <span className="text-emerald-400 font-bold font-mono">
                                {sangtaoQuota ? sangtaoQuota.quotaRemaining : '...'}
                            </span>
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                        </button>

                        {/** Dropdown Popover */}
                        {showSangtaoMenu && (
                            <>
                                <div
                                    className="fixed inset-0 z-40"
                                    onClick={() => setShowSangtaoMenu(false)}
                                />
                                <div className="absolute right-0 mt-2 w-72 rounded-2xl bg-fb-surface border border-slate-700/80 shadow-2xl p-4 z-50 text-xs text-fb-text animate-in fade-in zoom-in-95 duration-150">
                                    <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                                        <div className="flex items-center gap-2">
                                            <div className="w-7 h-7 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                                                <span className="material-symbols-outlined text-base">magic_button</span>
                                            </div>
                                            <div>
                                                <div className="font-bold text-fb-text text-sm leading-tight">SangTao.ai</div>
                                                <div className="text-[10px] text-emerald-400 font-medium">Hoạt động bình thường</div>
                                            </div>
                                        </div>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                ztteam_fetchSangTaoQuota();
                                            }}
                                            disabled={isRefreshingQuota}
                                            title="Làm mới thông tin"
                                            className="p-1 text-fb-text-muted hover:text-cyan-400 hover:bg-fb-surface-hover rounded-lg transition-colors cursor-pointer"
                                        >
                                            <span className={`material-symbols-outlined text-sm ${isRefreshingQuota ? 'animate-spin text-cyan-400' : ''}`}>
                                                sync
                                            </span>
                                        </button>
                                    </div>

                                    <div className="mt-3 space-y-2.5">
                                        <div className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center justify-between">
                                            <span className="text-fb-text-muted font-medium">Hạn mức còn lại:</span>
                                            <span className="text-lg font-black font-mono text-emerald-400">
                                                {sangtaoQuota?.quotaRemaining ?? 0} <span className="text-xs font-normal text-slate-400">lượt</span>
                                            </span>
                                        </div>

                                        <div className="space-y-1.5 px-0.5 text-[11px]">
                                            <div className="flex justify-between items-center text-slate-400">
                                                <span>Tài khoản:</span>
                                                <span className="font-mono text-fb-text truncate max-w-[150px]" title={sangtaoQuota?.email || 'dev.zota@gmail.com'}>
                                                    {sangtaoQuota?.email || 'dev.zota@gmail.com'}
                                                </span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-400">
                                                <span>Gói cước:</span>
                                                <span className="text-cyan-400 font-semibold">{sangtaoQuota?.capReason || 'Gói thuê bao'}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-400">
                                                <span>Song song:</span>
                                                <span className="text-fb-text font-mono">{sangtaoQuota?.concurrency || 5} luồng</span>
                                            </div>
                                            {sangtaoQuota?.updatedAt && (
                                                <div className="flex justify-between items-center text-slate-500 text-[10px] pt-1 border-t border-slate-800/60">
                                                    <span>Cập nhật:</span>
                                                    <span>{new Date(sangtaoQuota.updatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="mt-3 pt-2 border-t border-slate-800">
                                        <a
                                            href="https://sangtao.ai/agents"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center justify-center gap-1.5 w-full py-1.5 px-3 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 text-[11px] font-semibold border border-cyan-500/30 transition-all cursor-pointer"
                                        >
                                            <span>Mở trang SangTao.ai</span>
                                            <span className="material-symbols-outlined text-xs">open_in_new</span>
                                        </a>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="h-6 w-px bg-fb-surface-hover mx-1"></div>

                    {/* User Avatar */}
                    <div className="relative ml-1 cursor-pointer group flex items-center gap-2">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-fb-blue to-cyan-400 flex items-center justify-center overflow-hidden shrink-0 ring-2 ring-fb-blue/30">
                            <div className="text-white font-bold text-sm">
                                {user?.email?.[0].toUpperCase() || 'A'}
                            </div>
                        </div>
                        <span className="text-sm font-bold text-fb-text-muted group-hover:text-fb-text transition-colors uppercase tracking-wide hidden sm:inline max-w-[150px] truncate">{user?.email || 'ADMIN'}</span>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="w-full lg:pl-[260px] pt-16 min-h-screen bg-fb-bg flex flex-col">
                <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
                    <div className="mx-auto space-y-6">
                        <Outlet />
                    </div>
                </div>
            </main>
        </>
    );
}