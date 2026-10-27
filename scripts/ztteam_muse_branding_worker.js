/**
 * ZTTeam: Dịch vụ nền tạo Ảnh Bìa & Avatar Facebook tự động qua Muse.ai
 * Tác giả: ZTTeam (t4.goxo.us)
 * Cổng Chrome Debugger chuyên biệt: 9245 (hoặc chỉ định qua --chrome-port)
 * Profile Chrome chuyên biệt: %USERPROFILE%\chrome-muse-branding-profile
 * Tránh hoàn toàn xung đột cổng với các worker Reel/Video khác.
 */

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e1) {
  try {
    puppeteer = require('puppeteer');
  } catch (e2) {
    console.error('\n❌ LỖI: Chưa tìm thấy thư viện puppeteer-core hoặc puppeteer!');
    process.exit(1);
  }
}

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

/** Đọc tham số dòng lệnh */
const args = process.argv.slice(2);

const targetArg = args.find(a => a.startsWith('--target='));
const TARGET_URL = (targetArg ? targetArg.split('=')[1] : (process.env.TARGET_URL || 'http://169.58.190.115:3004')).replace(/\/$/, '');

const chromePortArg = args.find(a => a.startsWith('--chrome-port='));
const CHROME_PORT = chromePortArg ? chromePortArg.split('=')[1] : (process.env.CHROME_DEBUG_PORT || '9245');
const CHROME_DEBUG_URL = `http://127.0.0.1:${CHROME_PORT}`;

const workerNameArg = args.find(a => a.startsWith('--worker-name='));
const WORKER_NAME = workerNameArg ? workerNameArg.split('=')[1] : `Branding-Worker-${CHROME_PORT}`;

const POLL_INTERVAL_MS = 10000; /** 10 giây thăm dò hàng đợi một lần */
const TEMP_DIR = path.resolve(__dirname, `./worker_temp_branding_${CHROME_PORT}`);
const SUCCESS_COOLDOWN_SEC = 20;
const FAILURE_COOLDOWN_SEC = 20;

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let isProcessing = false;

/** Hàm đếm ngược thời gian nghỉ an toàn */
async function ztteam_cooldown(seconds, reason) {
  console.log(`\n⏳ [${WORKER_NAME}] [Nghỉ an toàn] ${reason}.`);
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r   ⏱️ [${WORKER_NAME}] Chờ ${i} giây trước khi tiếp tục...   `);
    await new Promise(r => setTimeout(r, 1000));
  }
  process.stdout.write('\r                                                              \r');
}

/** Kiểm tra cổng Chrome debugging có phản hồi không */
async function ztteam_isChromeRunning() {
  try {
    const res = await axios.get(`${CHROME_DEBUG_URL}/json/version`, { timeout: 2000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Gửi prompt vào khung chat Muse.ai và kích hoạt gửi
 */
async function ztteam_sendPromptToMuse(page, promptText) {
  console.log(`✍️ [${WORKER_NAME}] Đang nhập prompt vào Muse.ai...`);
  
  /** Đóng dấu các tin nhắn và ảnh cũ */
  await page.evaluate(() => {
    document.querySelectorAll('[data-message-author-role="assistant"], .prose, img').forEach(el => {
      el.setAttribute('data-ztteam-old', 'true');
    });
  });

  const textarea = await page.$('textarea');
  if (!textarea) throw new Error('Không tìm thấy khung nhập liệu textarea trên Muse.ai');
  await textarea.click();

  /** Dán prompt bằng React prototype setter */
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    const proto = Object.getPrototypeOf(ta);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(ta, text);
    } else {
      ta.value = text;
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    document.execCommand('insertText', false, ' ');
    document.execCommand('delete', false, null);
  }, promptText);

  await new Promise(r => setTimeout(r, 1000));

  /** Bấm nút gửi */
  console.log(`🚀 [${WORKER_NAME}] Đang bấm Gửi...`);
  await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;

    const allButtons = Array.from(document.querySelectorAll('button'));
    let targetBtn = allButtons.find(b => {
      if (b.disabled) return false;
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const title = (b.getAttribute('title') || '').toLowerCase();
      const text = (b.innerText || '').toLowerCase();
      return aria.includes('gửi') || aria.includes('send') || title.includes('gửi') || title.includes('send') || text.includes('gửi') || text.includes('send');
    });

    if (!targetBtn && ta.parentElement) {
      let parent = ta.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const btns = Array.from(parent.querySelectorAll('button'));
        for (const b of btns) {
          if (b.disabled) continue;
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          if (aria.includes('đính kèm') || aria.includes('attach') || aria.includes('xóa') || aria.includes('close') || b.querySelector('input[type="file"]')) {
            continue;
          }
          if (b.querySelector('svg')) {
            targetBtn = b;
            break;
          }
        }
        if (targetBtn) break;
        parent = parent.parentElement;
      }
    }

    if (targetBtn && !targetBtn.disabled) {
      targetBtn.click();
      return true;
    }
    return false;
  });

  /** Đánh dấu thời điểm gửi tin nhắn */
  await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (ta) {
      ta.setAttribute('data-ztteam-last-sent', Date.now().toString());
    }
  });

  await new Promise(r => setTimeout(r, 2000));
}

/**
 * Đợi Muse.ai tạo ảnh xong và trích xuất Buffer ảnh
 */
async function ztteam_waitForAndExtractImage(page, label, timeoutSec = 240) {
  console.log(`⏳ [${WORKER_NAME}] Đang đợi Muse.ai tạo [${label}] (tối đa ${timeoutSec}s)...`);
  const startTime = Date.now();

  while ((Date.now() - startTime) / 1000 < timeoutSec) {
    await new Promise(r => setTimeout(r, 3000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const checkResult = await page.evaluate(() => {
      const allButtons = Array.from(document.querySelectorAll('button'));
      const isGenerating = allButtons.some(b => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const title = (b.getAttribute('title') || '').toLowerCase();
        return aria.includes('dừng') || aria.includes('stop') || title.includes('dừng') || title.includes('stop');
      });

      /** Tìm ảnh mới được tạo bởi assistant */
      const assistantBubbles = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], .prose')).filter(el => {
        return el.getAttribute('data-ztteam-old') !== 'true';
      });

      let foundImgSrc = null;
      for (const bubble of assistantBubbles) {
        const imgs = Array.from(bubble.querySelectorAll('img')).filter(img => {
          const isAvatar = img.closest('.rounded-full') !== null || (img.width <= 48 && img.height <= 48);
          return !isAvatar && img.getAttribute('data-ztteam-old') !== 'true' && img.src;
        });

        if (imgs.length > 0) {
          foundImgSrc = imgs[imgs.length - 1].src;
          break;
        }
      }

      /** Nếu không có trong assistant bubble, quét toàn trang cho ảnh mới xuất hiện */
      if (!foundImgSrc) {
        const allNewImgs = Array.from(document.querySelectorAll('img')).filter(img => {
          const isAvatar = img.closest('.rounded-full') !== null || (img.width <= 48 && img.height <= 48);
          return !isAvatar && img.getAttribute('data-ztteam-old') !== 'true' && img.src && !img.src.includes('avatar');
        });
        if (allNewImgs.length > 0) {
          foundImgSrc = allNewImgs[allNewImgs.length - 1].src;
        }
      }

      return {
        isGenerating,
        foundImgSrc,
        hasBubbles: assistantBubbles.length > 0
      };
    });

    process.stdout.write(`\r   ⏱️ [${WORKER_NAME}] [${label}] Đang tạo: ${elapsed}s | Sinh ảnh: ${checkResult.isGenerating ? 'ĐANG CHẠY' : 'ĐÃ DỪNG'} | Phát hiện ảnh: ${checkResult.foundImgSrc ? 'CÓ' : 'Chưa'}...`);

    if (checkResult.foundImgSrc && !checkResult.isGenerating && elapsed >= 10) {
      console.log(`\n🎉 [${WORKER_NAME}] Đã hoàn tất tạo [${label}] sau ${elapsed} giây!`);
      
      /** Trích xuất dữ liệu ảnh */
      const base64Data = await page.evaluate(async (src) => {
        try {
          if (src.startsWith('data:image/')) return src;
          const res = await fetch(src);
          const blob = await res.blob();
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return null;
        }
      }, checkResult.foundImgSrc);

      if (base64Data && base64Data.includes(',')) {
        const base64Part = base64Data.split(',')[1];
        return Buffer.from(base64Part, 'base64');
      }

      /** Dự phòng: Tìm phần tử ảnh để chụp screenshot */
      console.log(`📸 [${WORKER_NAME}] Sử dụng dự phòng screenshot phần tử ảnh...`);
      const imgHandle = await page.$('img:not([data-ztteam-old="true"]):not(.rounded-full)');
      if (imgHandle) {
        return await imgHandle.screenshot({ type: 'png' });
      }
    }
  }

  throw new Error(`Quá thời gian chờ tạo [${label}] trên Muse.ai (${timeoutSec}s)`);
}

/**
 * Xử lý 1 Branding Job cho 1 Fanpage
 */
async function ztteam_processBrandingJob(job) {
  console.log(`\n========================================================`);
  console.log(`🎨 [${WORKER_NAME}] BẮT ĐẦU JOB TẠO BRANDING FANPAGE`);
  console.log(`📄 Page ID  : ${job.pageId}`);
  console.log(`📛 Tên Page : ${job.pageName}`);
  console.log(`🎯 Loại     : ${job.type} (${job.theme || 'Mặc định'})`);
  console.log(`⚡ Tự Áp Dụng: ${job.autoApply ? 'BẬT (Meta Graph API)' : 'TẮT (Chỉ lưu vào hệ thống)'}`);
  console.log(`========================================================`);

  const localAvatarPath = path.join(TEMP_DIR, `avatar_${job.pageId}.png`);
  const localCoverPath = path.join(TEMP_DIR, `cover_${job.pageId}.png`);

  let browser = null;
  let page = null;

  try {
    /** 1. Kết nối Chrome qua Remote Debugging Port */
    console.log(`🌐 [${WORKER_NAME}] Đang kết nối tới Chrome (${CHROME_DEBUG_URL})...`);
    browser = await puppeteer.connect({
      browserURL: CHROME_DEBUG_URL,
      defaultViewport: null,
      protocolTimeout: 300000,
    });

    const pages = await browser.pages();
    page = pages.find(p => p.url().includes('muse.ai')) || pages[0];
    if (!page) {
      page = await browser.newPage();
    }
    await page.bringToFront();

    let avatarGenerated = false;
    let coverGenerated = false;

    /** 2. Tạo Avatar nếu yêu cầu */
    if (job.type === 'avatar' || job.type === 'both') {
      console.log(`\n🖼️ [${WORKER_NAME}] [1/2] Tiến hành tạo Ảnh Đại Diện (Avatar)...`);
      /** Reset tab Muse để giải phóng RAM & sạch dữ liệu cũ */
      await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('textarea', { timeout: 25000 });
      await new Promise(r => setTimeout(r, 2000));

      const avatarPrompt = (job.avatarPrompt || `Thiết kế ảnh đại diện (avatar icon) hình vuông tỉ lệ 1:1 cho fanpage "${job.pageName}", phong cách chuyên nghiệp, hiện đại, sắc nét 4K 1024x1024`).replace(/\{PAGE_NAME\}/g, job.pageName);
      
      await ztteam_sendPromptToMuse(page, avatarPrompt);
      const avatarBuffer = await ztteam_waitForAndExtractImage(page, 'Avatar', 180);
      fs.writeFileSync(localAvatarPath, avatarBuffer);
      console.log(`💾 [${WORKER_NAME}] Đã lưu Avatar tạm: ${localAvatarPath} (${Math.round(avatarBuffer.length / 1024)} KB)`);
      avatarGenerated = true;

      await new Promise(r => setTimeout(r, 3000));
    }

    /** 3. Tạo Cover nếu yêu cầu */
    if (job.type === 'cover' || job.type === 'both') {
      console.log(`\n🖼️ [${WORKER_NAME}] [2/2] Tiến hành tạo Ảnh Bìa (Cover Banner)...`);
      /** Reset tab Muse cho Cover */
      await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('textarea', { timeout: 25000 });
      await new Promise(r => setTimeout(r, 2000));

      const coverPrompt = (job.coverPrompt || `Thiết kế ảnh bìa (cover banner) Facebook ngang tỉ lệ 16:9 (1920x1080) cho fanpage "${job.pageName}", chủ đề hấp dẫn, bố cục cân đối chừa khoảng trống cho avatar`).replace(/\{PAGE_NAME\}/g, job.pageName);
      
      await ztteam_sendPromptToMuse(page, coverPrompt);
      const coverBuffer = await ztteam_waitForAndExtractImage(page, 'Cover', 180);
      fs.writeFileSync(localCoverPath, coverBuffer);
      console.log(`💾 [${WORKER_NAME}] Đã lưu Cover tạm: ${localCoverPath} (${Math.round(coverBuffer.length / 1024)} KB)`);
      coverGenerated = true;
    }

    /** 4. Upload kết quả lên VPS qua /attach-result */
    console.log(`\n📤 [${WORKER_NAME}] Đang tải ảnh thành phẩm lên máy chủ VPS (${TARGET_URL})...`);
    const formData = new FormData();
    formData.append('autoApply', job.autoApply ? 'true' : 'false');

    if (avatarGenerated && fs.existsSync(localAvatarPath)) {
      formData.append('avatar', fs.createReadStream(localAvatarPath));
    }
    if (coverGenerated && fs.existsSync(localCoverPath)) {
      formData.append('cover', fs.createReadStream(localCoverPath));
    }

    const uploadRes = await axios.post(
      `${TARGET_URL}/api/facebook/pages/branding/${job.pageId}/attach-result`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 60000,
      }
    );

    console.log(`========================================================`);
    console.log(`🎉 HOÀN TẤT THÀNH CÔNG JOB CHO PAGE: [${job.pageName}]!`);
    const resData = uploadRes.data?.data || uploadRes.data || {};
    console.log(`🖼️ Avatar URL : ${resData.avatarUrl || 'N/A'}`);
    console.log(`🖼️ Cover URL  : ${resData.coverUrl || 'N/A'}`);
    console.log(`⚡ Meta Apply : ${resData.appliedFacebook ? 'THÀNH CÔNG' : (resData.applyMessage || 'Chưa áp dụng')}`);
    console.log(`========================================================\n`);

    await ztteam_cooldown(SUCCESS_COOLDOWN_SEC, 'Hoàn tất branding 1 Page. Tạm nghỉ');
  } catch (err) {
    console.error(`\n❌ [${WORKER_NAME}] LỖI XỬ LÝ JOB CHO PAGE #${job.pageId}:`, err.message);

    /** Báo lỗi về server để giải phóng hàng đợi */
    try {
      await axios.post(`${TARGET_URL}/api/facebook/pages/branding/${job.pageId}/reset`, {
        error: err.message
      });
      console.log(`⚠️ [${WORKER_NAME}] Đã chuyển trạng thái FAILED trên máy chủ.`);
    } catch (e) {
      console.error(`[${WORKER_NAME}] Không thể gửi reset lên VPS:`, e.message);
    }

    await ztteam_cooldown(FAILURE_COOLDOWN_SEC, 'Gặp lỗi trong quá trình tạo ảnh. Tạm nghỉ');
  } finally {
    if (browser) {
      try { browser.disconnect(); } catch (e) {}
    }
    if (fs.existsSync(localAvatarPath)) {
      try { fs.unlinkSync(localAvatarPath); } catch (e) {}
    }
    if (fs.existsSync(localCoverPath)) {
      try { fs.unlinkSync(localCoverPath); } catch (e) {}
    }
  }
}

/** Vòng lặp chính của Branding Worker */
async function ztteam_brandingWorkerLoop() {
  if (isProcessing) return;

  try {
    const isChromeAlive = await ztteam_isChromeRunning();
    if (!isChromeAlive) {
      process.stdout.write(`\r⏳ [${WORKER_NAME}] Đang chờ mở Chrome tại ${CHROME_DEBUG_URL}... (Chạy start_chrome_branding_muse.bat)   `);
      return;
    }

    /** Thăm dò job từ VPS */
    let pendingRes;
    try {
      pendingRes = await axios.get(`${TARGET_URL}/api/facebook/pages/branding/pending-job`, { timeout: 10000 });
    } catch (apiErr) {
      process.stdout.write(`\r⚠️ [${WORKER_NAME}] Không thể kết nối VPS (${TARGET_URL}): ${apiErr.message}   `);
      return;
    }

    if (pendingRes.data?.job) {
      isProcessing = true;
      try {
        await ztteam_processBrandingJob(pendingRes.data.job);
      } finally {
        isProcessing = false;
      }
    } else {
      process.stdout.write(`\r💤 [${WORKER_NAME}] Hàng đợi trống. Đang chờ job mới từ VPS (${TARGET_URL})...   `);
    }
  } catch (err) {
    console.error(`\n[${WORKER_NAME}] Lỗi vòng lặp worker:`, err.message);
  }
}

/** Khởi động worker */
console.log(`========================================================`);
console.log(`🚀 ZTTEAM - MUSE BRANDING WORKER (AVATAR & COVER)`);
console.log(`🌐 Máy chủ VPS : ${TARGET_URL}`);
console.log(`🔌 Cổng Chrome : ${CHROME_DEBUG_URL}`);
console.log(`📂 Thư mục tạm : ${TEMP_DIR}`);
console.log(`========================================================\n`);

setInterval(ztteam_brandingWorkerLoop, POLL_INTERVAL_MS);
ztteam_brandingWorkerLoop();
