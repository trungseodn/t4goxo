import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { useUIStore } from '../stores/uiStore';
import { useZTTeamFacebookStore } from '../stores/facebookStore';
import CustomDropdown from '../components/CustomDropdown';

export default function SystemSettingsPage() {
  const { ztteam_showToast } = useUIStore();
  const { pages, ztteam_fetchPagesFromDB } = useZTTeamFacebookStore();

  const [settings, setSettings] = useState({
    openai_api_key: '',
    deepseek_api_key: '',
    gemini_api_key: '',
    active_ai_provider: 'openai',
    remotion_license: '',
    max_concurrent_jobs: '2',
    video_retention_days: '7',
    telegram_bot_token: '',
    telegram_chat_id: '',
    youtube_cookies: '',
    elevenlabs_api_key: '',
    notify_publish_success: true,
    notify_publish_error: true,
    notify_crawl_success: false
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [ztteam_isTestingTelegram, setZtteam_isTestingTelegram] = useState(false);

  /** BGM Library State */
  const [bgmList, setBgmList] = useState<any[]>([]);
  const [isLoadingBgm, setIsLoadingBgm] = useState(false);
  const [isUploadingBgm, setIsUploadingBgm] = useState(false);
  const [currentPlayingBgm, setCurrentPlayingBgm] = useState<string | null>(null);
  const [bgmAudio, setBgmAudio] = useState<HTMLAudioElement | null>(null);

  /** AI Live Health State */
  const [aiHealth, setAiHealth] = useState<any>(null);
  const [isCheckingAiHealth, setIsCheckingAiHealth] = useState(false);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await api.get('settings');
        setSettings(prev => ({ ...prev, ...res.data }));
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSettings();
    ztteam_fetchPagesFromDB();
    ztteam_fetchBgmList();
    ztteam_checkAiHealth();

    return () => {
      if (bgmAudio) bgmAudio.pause();
    };
  }, []);

  /** ZTTeam: Kiểm tra trực tiếp thông số và hạn ngạch AI */
  const ztteam_checkAiHealth = async () => {
    try {
      setIsCheckingAiHealth(true);
      const res = await api.get('settings/ai-health');
      setAiHealth(res.data);
    } catch (e: any) {
      console.error(e);
    } finally {
      setIsCheckingAiHealth(false);
    }
  };

  const ztteam_fetchBgmList = async () => {
    try {
      setIsLoadingBgm(true);
      const res = await api.get('media/bgm');
      if (res.data?.success && Array.isArray(res.data?.data)) {
        setBgmList(res.data.data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingBgm(false);
    }
  };

  const ztteam_togglePlayBgm = (url: string, filename: string) => {
    if (currentPlayingBgm === filename && bgmAudio) {
      bgmAudio.pause();
      setCurrentPlayingBgm(null);
      setBgmAudio(null);
      return;
    }

    if (bgmAudio) bgmAudio.pause();

    const audio = new Audio(url);
    audio.play();
    audio.onended = () => {
      setCurrentPlayingBgm(null);
      setBgmAudio(null);
    };
    setBgmAudio(audio);
    setCurrentPlayingBgm(filename);
  };

  const ztteam_handleUploadBgm = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsUploadingBgm(true);
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post('media/bgm/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.success) {
        ztteam_showToast('Đã tải bài nhạc lên thư viện thành công!', 'success');
        await ztteam_fetchBgmList();
      }
    } catch (err: any) {
      ztteam_showToast(err.response?.data?.message || 'Lỗi khi tải file âm thanh', 'error');
    } finally {
      setIsUploadingBgm(false);
      e.target.value = '';
    }
  };

  const ztteam_handleDeleteBgm = async (filename: string) => {
    if (!window.confirm(`Bạn có chắc chắn muốn xóa bản nhạc "${filename}" khỏi hệ thống?`)) return;

    try {
      if (currentPlayingBgm === filename && bgmAudio) {
        bgmAudio.pause();
        setCurrentPlayingBgm(null);
        setBgmAudio(null);
      }
      await api.delete(`media/bgm/${filename}`);
      ztteam_showToast('Đã xóa bản nhạc thành công!', 'success');
      await ztteam_fetchBgmList();
    } catch (err: any) {
      ztteam_showToast(err.response?.data?.message || 'Lỗi xóa file âm thanh', 'error');
    }
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      await api.put('settings', settings);
      ztteam_showToast('Đã lưu cấu hình thành công!', 'success');
    } catch (e) {
      ztteam_showToast('Lỗi khi lưu cấu hình', 'error');
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value;
    setSettings(prev => ({ ...prev, [e.target.name]: value }));
  };

  const ztteam_handleTestTelegram = async () => {
    if (!settings.telegram_bot_token || !settings.telegram_chat_id) {
      ztteam_showToast('Vui lòng nhập đầy đủ Telegram Bot Token và Chat ID', 'warning');
      return;
    }
    try {
      setZtteam_isTestingTelegram(true);
      const res = await api.post('telegram/test', {
        token: settings.telegram_bot_token,
        chatId: settings.telegram_chat_id
      });
      if (res.data?.success) {
        ztteam_showToast('Gửi tin nhắn thử nghiệm Telegram thành công!', 'success');
      } else {
        ztteam_showToast(res.data?.message || 'Không thể kết nối đến Telegram', 'error');
      }
    } catch (e: any) {
      ztteam_showToast(e.response?.data?.message || e.message || 'Lỗi khi kiểm tra kết nối Telegram', 'error');
    } finally {
      setZtteam_isTestingTelegram(false);
    }
  };

  const activePages = pages.filter(p => p.isActive !== false);

  if (isLoading) return <div className="p-8 text-fb-text-muted">Đang tải...</div>;

  return (
    <div className="w-full">
      {/* Header */}
      <div className="bg-fb-surface rounded-2xl shadow-lg p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-black text-fb-text tracking-tight">Cài Đặt Hệ Thống</h2>
          <p className="text-sm font-medium text-fb-text-muted mt-1">Quản lý kết nối Facebook API, Khóa AI Engine và cấu hình đăng bài.</p>
        </div>
        <button 
          onClick={handleSave}
          disabled={isSaving}
          className="bg-gradient-to-r from-fb-blue to-cyan-500 hover:opacity-90 disabled:opacity-50 text-white px-5 py-2.5 rounded-full text-sm font-bold transition-all shadow-lg shadow-blue-500/25 flex items-center gap-2 self-start sm:self-auto"
        >
          <span className="material-symbols-outlined text-lg shrink-0">save</span>
          <span>{isSaving ? 'Đang lưu...' : 'Lưu Cấu Hình'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-6">
          
          {/* Section 1: Facebook Page Connections */}
          <div className="bg-gradient-to-br from-fb-surface via-fb-surface to-blue-950/30 p-5 rounded-2xl shadow-lg space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-fb-text flex items-center gap-2">
                  <div className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-blue-500/15 text-blue-400">
                    <span className="material-symbols-outlined text-xl">hub</span>
                  </div>
                  <span>Trang Đã Kết Nối</span>
                </h3>
                <p className="text-xs font-medium text-fb-text-muted mt-0.5">Quản lý quyền tự động đăng Reels và bài viết lên Fanpage.</p>
              </div>
              <button className="bg-gradient-to-r from-fb-blue to-cyan-500 text-white px-4 py-2 rounded-full text-xs font-bold shadow-md shadow-blue-500/20 hover:opacity-90 transition-colors">
                + Thêm Trang Mới
              </button>
            </div>

            <div className="space-y-3">
              {activePages.length > 0 ? activePages.map(page => {
                const initials = page.name ? page.name.substring(0, 2).toUpperCase() : 'FB';
                return (
                  <div key={page.id} className="p-4 bg-fb-surface-hover rounded-2xl flex items-center justify-between shadow-sm">
                    <div className="flex items-center gap-3">
                      {page.avatar ? (
                        <img src={page.avatar} alt={page.name} className="w-10 h-10 shrink-0 rounded-xl object-cover shadow-md shadow-blue-500/10" />
                      ) : (
                        <div className="w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-blue-500 to-fb-blue text-white font-black flex items-center justify-center shadow-md shadow-blue-500/30">
                          {initials}
                        </div>
                      )}
                      <div>
                        <h4 className="text-sm font-bold text-fb-text">{page.name}</h4>
                        <p className="text-xs text-blue-400 font-bold">ID: {page.id} {page.followersCount !== undefined ? `• ${page.followersCount.toLocaleString()} Follower` : ''}</p>
                      </div>
                    </div>
                    <span className="px-2.5 sm:px-3.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] sm:text-xs font-bold border border-emerald-500/20 flex items-center gap-1.5 shrink-0 whitespace-nowrap">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse"></span>
                      Đã kết nối
                    </span>
                  </div>
                );
              }) : (
                <div className="p-4 bg-fb-surface-hover rounded-2xl text-center text-sm text-fb-text-muted font-medium">
                  Chưa có trang nào được kết nối.
                </div>
              )}
            </div>
          </div>

          {/* Section 2: AI Engine API Key Settings */}
          <div className="bg-gradient-to-br from-fb-surface via-fb-surface to-cyan-950/30 p-5 rounded-2xl shadow-lg space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-fb-text flex items-center gap-2">
                  <div className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-400">
                    <span className="material-symbols-outlined text-xl">key</span>
                  </div>
                  <span>Cấu Hình Khóa AI Engine API</span>
                </h3>
                <p className="text-xs font-medium text-fb-text-muted mt-0.5">Dùng để tự động tạo kịch bản, giọng đọc Voiceover và render Reels.</p>
              </div>
              <button 
                type="button" 
                onClick={ztteam_checkAiHealth}
                disabled={isCheckingAiHealth}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500 hover:text-white transition-all disabled:opacity-50"
                title="Kiểm tra thông số kết nối & hạn ngạch thực tế"
              >
                <span className={`material-symbols-outlined text-base ${isCheckingAiHealth ? 'animate-spin' : ''}`}>sync</span>
                <span>{isCheckingAiHealth ? 'Đang test...' : 'Kiểm tra API'}</span>
              </button>
            </div>

            {/** Bảng giám sát thông số & hạn ngạch AI thời gian thực */}
            {aiHealth && (
              <div className="bg-fb-surface-hover/60 border border-white/5 rounded-2xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold text-fb-text uppercase tracking-wider flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm text-cyan-400">monitoring</span>
                    Thông số & Hạn Ngạch AI Thời Gian Thực
                  </span>
                  <span className="text-[10px] text-fb-text-muted font-medium">Provider ưu tiên: <strong className="text-cyan-400 uppercase">{aiHealth.activeProvider}</strong></span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  {/** Card Google Gemini */}
                  <div className="p-3 rounded-xl bg-black/20 border border-white/5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-amber-400 flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">bolt</span>
                        Google Gemini
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${
                        aiHealth.gemini?.status === 'HEALTHY' 
                          ? 'bg-emerald-500/15 text-emerald-400' 
                          : (aiHealth.gemini?.status === 'QUOTA_EXCEEDED' ? 'bg-amber-500/15 text-amber-400' : 'bg-red-500/15 text-red-400')
                      }`}>
                        {aiHealth.gemini?.status === 'HEALTHY' ? 'ONLINE' : (aiHealth.gemini?.status === 'QUOTA_EXCEEDED' ? 'HẾT QUOTA (429)' : 'LỖI')}
                      </span>
                    </div>
                    <div className="text-[11px] text-fb-text-muted space-y-0.5">
                      <p>Model: <strong className="text-fb-text">{aiHealth.gemini?.model}</strong></p>
                      <p>Hạn ngạch: <strong className="text-amber-400">{aiHealth.gemini?.quotaTier}</strong></p>
                      {aiHealth.gemini?.latencyMs > 0 && <p>Độ trễ: <strong className="text-emerald-400">{aiHealth.gemini?.latencyMs} ms</strong></p>}
                      <p className="text-[10px] text-fb-text-muted/80 truncate mt-1" title={aiHealth.gemini?.message}>{aiHealth.gemini?.message}</p>
                    </div>
                  </div>

                  {/** Card OpenAI */}
                  <div className="p-3 rounded-xl bg-black/20 border border-white/5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-cyan-400 flex items-center gap-1">
                        <span className="material-symbols-outlined text-sm">smart_toy</span>
                        OpenAI (Dự phòng)
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${
                        aiHealth.openai?.status === 'HEALTHY' 
                          ? 'bg-emerald-500/15 text-emerald-400' 
                          : (aiHealth.openai?.status === 'NOT_CONFIGURED' ? 'bg-white/10 text-fb-text-muted' : 'bg-red-500/15 text-red-400')
                      }`}>
                        {aiHealth.openai?.status === 'HEALTHY' ? 'SẴN SÀNG' : (aiHealth.openai?.status === 'NOT_CONFIGURED' ? 'CHƯA CÓ KEY' : 'LỖI')}
                      </span>
                    </div>
                    <div className="text-[11px] text-fb-text-muted space-y-0.5">
                      <p>Model: <strong className="text-fb-text">{aiHealth.openai?.model}</strong></p>
                      <p>Vai trò: <strong className="text-cyan-400">Tự động thay thế khi Gemini hết hạn</strong></p>
                      {aiHealth.openai?.latencyMs > 0 && <p>Độ trễ: <strong className="text-emerald-400">{aiHealth.openai?.latencyMs} ms</strong></p>}
                      <p className="text-[10px] text-fb-text-muted/80 truncate mt-1" title={aiHealth.openai?.message}>{aiHealth.openai?.message}</p>
                    </div>
                  </div>
                </div>

              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-cyan-400 mb-1.5">Mô Hình AI Xử Lý Chính</label>
                <CustomDropdown
                  value={settings.active_ai_provider || 'openai'}
                  onChange={(val) => setSettings(prev => ({ ...prev, active_ai_provider: val }))}
                  options={[
                    { value: 'openai', label: 'OpenAI (GPT-4)' },
                    { value: 'gemini', label: 'Google Gemini' },
                    { value: 'deepseek', label: 'DeepSeek AI' }
                  ]}
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-amber-400 mb-1.5">Google Gemini API Key (Khuyên dùng - Tiết kiệm chi phí)</label>
                <input 
                  type="password" 
                  name="gemini_api_key"
                  value={settings.gemini_api_key || ''}
                  onChange={handleChange}
                  placeholder="AIzaSy..."
                  className="w-full p-3 bg-fb-surface-hover text-fb-text rounded-full text-xs font-medium border-none focus:outline-none focus:ring-2 focus:ring-amber-400 px-4"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-cyan-400 mb-1.5">OpenAI API Key</label>
                <input 
                  type="password" 
                  name="openai_api_key"
                  value={settings.openai_api_key || ''}
                  onChange={handleChange}
                  placeholder="sk-..."
                  className="w-full p-3 bg-fb-surface-hover text-fb-text rounded-full text-xs font-medium border-none focus:outline-none focus:ring-2 focus:ring-cyan-400 px-4"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-emerald-400 mb-1.5">DeepSeek API Key</label>
                <input 
                  type="password" 
                  name="deepseek_api_key"
                  value={settings.deepseek_api_key || ''}
                  onChange={handleChange}
                  placeholder="sk-..."
                  className="w-full p-3 bg-fb-surface-hover text-fb-text rounded-full text-xs font-medium border-none focus:outline-none focus:ring-2 focus:ring-emerald-400 px-4"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-blue-400 mb-1.5">ElevenLabs Voiceover Key (Tùy chọn)</label>
                <input 
                  type="password" 
                  name="elevenlabs_api_key"
                  value={settings.elevenlabs_api_key || ''}
                  onChange={handleChange}
                  placeholder="Nhập ElevenLabs Key nếu muốn dùng giọng đọc tùy chỉnh..." 
                  className="w-full p-3 bg-fb-surface-hover text-fb-text placeholder:text-fb-text-muted rounded-full text-xs font-medium border-none focus:outline-none focus:ring-2 focus:ring-blue-400 px-4"
                />
              </div>
            </div>
          </div>

        </div>

        {/* Right Column */}
        <div className="space-y-6">
          
          {/* Section 3: Notification Preferences */}
          <div className="bg-fb-surface p-5 rounded-2xl shadow-lg space-y-4">
            <h3 className="text-base font-bold text-fb-text flex items-center gap-2">
              <div className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
                <span className="material-symbols-outlined text-xl">notifications_active</span>
              </div>
              <span>Cấu Hình Thông Báo</span>
            </h3>

            <div className="space-y-3">
              <label className="flex items-center justify-between p-3.5 bg-fb-surface-hover/50 rounded-2xl cursor-pointer">
                <div>
                  <p className="text-xs font-bold text-fb-text">Thông báo khi bài đăng xuất bản thành công</p>
                  <p className="text-[11px] text-fb-text-muted mt-0.5">Nhận thông báo qua Telegram khi hệ thống đăng bài xong.</p>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" name="notify_publish_success" checked={settings.notify_publish_success !== false} onChange={handleChange} className="sr-only peer" />
                  <div className="w-9 h-5 bg-fb-surface-hover peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                </div>
              </label>

              <label className="flex items-center justify-between p-3.5 bg-fb-surface-hover/50 rounded-2xl cursor-pointer">
                <div>
                  <p className="text-xs font-bold text-fb-text">Thông báo lỗi Crawler / Render AI</p>
                  <p className="text-[11px] text-fb-text-muted mt-0.5">Cảnh báo ngay lập tức nếu tiến trình tự động hóa bị lỗi.</p>
                </div>
                <div className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" name="notify_publish_error" checked={settings.notify_publish_error !== false} onChange={handleChange} className="sr-only peer" />
                  <div className="w-9 h-5 bg-fb-surface-hover peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-red-500"></div>
                </div>
              </label>
            </div>
            
            <div className="pt-4 border-t border-fb-surface-hover space-y-3">
              <div>
                <label className="block text-xs font-bold text-fb-text mb-1.5">Telegram Bot Token</label>
                <input 
                  type="text" 
                  name="telegram_bot_token"
                  value={settings.telegram_bot_token || ''}
                  onChange={handleChange}
                  placeholder="123456789:ABCDefgh..." 
                  className="w-full p-3 bg-fb-surface-hover text-fb-text placeholder:text-fb-text-muted rounded-xl text-xs font-medium border-none focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-fb-text mb-1.5">Telegram Chat ID</label>
                <input 
                  type="text" 
                  name="telegram_chat_id"
                  value={settings.telegram_chat_id || ''}
                  onChange={handleChange}
                  placeholder="-100123456789" 
                  className="w-full p-3 bg-fb-surface-hover text-fb-text placeholder:text-fb-text-muted rounded-xl text-xs font-medium border-none focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
              </div>

              <button
                type="button"
                onClick={ztteam_handleTestTelegram}
                disabled={ztteam_isTestingTelegram}
                className="w-full mt-2 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 font-bold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-2 transition-all disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-base">send</span>
                <span>{ztteam_isTestingTelegram ? 'Đang kiểm tra kết nối...' : 'Kiểm Tra Kết Nối Telegram'}</span>
              </button>
            </div>
          </div>

          {/* Section 4: System Parameters */}
          <div className="bg-fb-surface p-5 rounded-2xl shadow-lg space-y-4">
            <h3 className="text-base font-bold text-fb-text flex items-center gap-2">
              <div className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-blue-500/15 text-blue-400">
                <span className="material-symbols-outlined text-xl">settings_system_daydream</span>
              </div>
              <span>Tham Số Hệ Thống</span>
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-fb-text mb-1.5">Giới hạn Render AI đồng thời</label>
                <CustomDropdown
                  value={settings.max_concurrent_jobs || '2'}
                  onChange={(val) => setSettings(prev => ({ ...prev, max_concurrent_jobs: val }))}
                  options={[
                    { value: '1', label: '1 Tiến trình' },
                    { value: '2', label: '2 Tiến trình (Khuyên dùng)' },
                    { value: '4', label: '4 Tiến trình (Cần Server mạnh)' }
                  ]}
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-fb-text mb-1.5">Tự động xóa Video/Ảnh sau</label>
                <CustomDropdown
                  value={settings.video_retention_days || '7'}
                  onChange={(val) => setSettings(prev => ({ ...prev, video_retention_days: val }))}
                  options={[
                    { value: '3', label: '3 Ngày' },
                    { value: '7', label: '7 Ngày' },
                    { value: '30', label: '30 Ngày' },
                    { value: '0', label: 'Không bao giờ xóa' }
                  ]}
                />
                <p className="text-[11px] text-fb-text-muted mt-1">Giúp giải phóng dung lượng ổ cứng cho Server.</p>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/** Section 5: BGM Audio Library */}
      <div className="mt-6 bg-gradient-to-br from-fb-surface via-fb-surface to-cyan-950/20 p-5 rounded-2xl shadow-lg border border-fb-surface-hover/50 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-fb-surface-hover/60">
          <div>
            <h3 className="text-base font-bold text-fb-text flex items-center gap-2">
              <div className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-400">
                <span className="material-symbols-outlined text-xl">library_music</span>
              </div>
              <span>Thư Viện Âm Thanh & Nhạc Nền Reels (BGM Library)</span>
            </h3>
            <p className="text-xs font-medium text-fb-text-muted mt-0.5">
              Kho nhạc nền tự động hòa âm cho Video Hook 10s. Bạn có thể nghe thử, xóa và tải lên các bản nhạc MP3, M4A, WAV mới.
            </p>
          </div>

          <label className="bg-gradient-to-r from-fb-blue to-cyan-500 text-white px-4 py-2 rounded-full text-xs font-bold shadow-md shadow-blue-500/20 hover:opacity-90 transition-all flex items-center gap-1.5 cursor-pointer self-start sm:self-auto shrink-0">
            <span className="material-symbols-outlined text-base">{isUploadingBgm ? 'sync' : 'upload_file'}</span>
            <span>{isUploadingBgm ? 'Đang tải lên...' : '+ Tải Âm Thanh Mới'}</span>
            <input
              type="file"
              accept="audio/mp3,audio/wav,audio/m4a,audio/aac"
              className="hidden"
              onChange={ztteam_handleUploadBgm}
              disabled={isUploadingBgm}
            />
          </label>
        </div>

        {isLoadingBgm ? (
          <div className="p-8 text-center text-xs font-bold text-fb-text-muted flex items-center justify-center gap-2">
            <span className="material-symbols-outlined animate-spin text-base text-cyan-400">sync</span>
            Đang tải danh sách bài hát...
          </div>
        ) : bgmList.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {bgmList.map(bgm => {
              const isPlaying = currentPlayingBgm === bgm.filename;
              const isDefault = bgm.filename === 'kiss_of_spring.mp3';

              return (
                <div
                  key={bgm.id}
                  className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between gap-3 ${
                    isPlaying
                      ? 'bg-amber-500/10 border-amber-500/40 shadow-sm'
                      : 'bg-fb-surface-hover/40 border-fb-surface-hover/60 hover:border-cyan-500/30'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={() => ztteam_togglePlayBgm(bgm.url, bgm.filename)}
                      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all shrink-0 cursor-pointer ${
                        isPlaying
                          ? 'bg-amber-400 text-black shadow-md shadow-amber-400/20'
                          : 'bg-fb-surface text-cyan-400 hover:bg-cyan-500/20 border border-white/5'
                      }`}
                      title={isPlaying ? 'Dừng phát' : 'Nghe thử bản nhạc'}
                    >
                      <span className="material-symbols-outlined text-xl">
                        {isPlaying ? 'pause' : 'play_arrow'}
                      </span>
                    </button>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-xs font-bold text-fb-text truncate">{bgm.name}</h4>
                        {isDefault && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
                            Khuyên dùng
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-fb-text-muted truncate mt-0.5">
                        {bgm.filename} • {bgm.size_formatted}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => ztteam_handleDeleteBgm(bgm.filename)}
                      className="p-1.5 hover:bg-rose-500/20 text-fb-text-muted hover:text-rose-400 rounded-lg transition-colors cursor-pointer"
                      title="Xóa bài hát này"
                    >
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-8 text-center text-xs font-medium text-fb-text-muted bg-fb-surface-hover/20 rounded-2xl border border-dashed border-white/10">
            Chưa có bài hát nào trong thư viện. Bấm "+ Tải Âm Thanh Mới" để thêm bản nhạc nền MP3 đầu tiên!
          </div>
        )}
      </div>
    </div>
  );
}
