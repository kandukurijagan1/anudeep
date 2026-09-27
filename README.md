# Anudeep Khadi Bandar - Tax Invoice & Billing System

A high-speed, modern GST billing and tax invoice web application with automated WhatsApp invoice delivery, Telegram backup, customer autocomplete, and dual-database support (Local MongoDB & Cloud Google Apps Script).

## 🖥️ Dedicated POS Workstation Application

The system provides multiple ways to run as a dedicated, high-speed POS workstation application:

### 1. Windows Native Launcher (.exe & .bat)
- **Launchers**: `Launch-AKB-App.bat` and `AKB-Billing.exe`
- **Desktop Shortcut**: **`Anudeep Khadi Bandar - GST Billing.lnk`** on your Windows Desktop.
- **Key Capabilities**:
  - Full-screen distraction-free native desktop workstation window with official AKB branding.
  - Dedicated isolated user profile keeping credentials and drafts permanently remembered.
  - Automatic background Node server auto-healing and fallback to Cloud GAS if offline.
  - System Tray menu (Open, New Bill `F2`, Invoice History, Sync).
  - To rebuild: `npm run build:exe` and `npm run setup:shortcut`

### 2. Standalone Electron Dedicated App
- **Run Locally**: `npm run electron`
- **Package as Standalone Windows Executable**: `npm run package:app`
- Features single-instance locking, native print spooling, and hardware-accelerated rendering.

### 3. In-Browser Dedicated PWA App
- Open the application in Chrome or Edge and click **"Dedicated App"** in the sidebar navigation or **"Install PWA App"** in Settings.
- Installs directly to Windows Apps, taskbar, and start menu with 100% offline support.

### ⚡ Workstation Billing Hotkeys:
- **`F2`** &rarr; Quick New Invoice (focuses customer name)
- **`F4`** &rarr; Focus Product Selection
- **`F8` / `Ctrl + S`** &rarr; Save & Generate Invoice
- **`Ctrl + P`** &rarr; Direct Print Spooler
- **`Ctrl + H`** &rarr; Open Invoice History
- **`Esc`** &rarr; Dismiss any modal or overlay

---

## 🚀 Instant Deployment / Publishing

### Option 1: Deploy on Vercel (Fastest & Free)
1. Go to [vercel.com](https://vercel.com) and log in with your GitHub account.
2. Click **"Add New Project"** $\rightarrow$ **"Import"** and select **`anudeep-deploy`**.
3. Keep default settings (the included `vercel.json` automatically configures everything).
4. Click **Deploy**. Your app will be live with a free SSL domain (e.g., `https://anudeep-deploy.vercel.app`) in under 1 minute!

---

### Option 2: Deploy on GitHub Pages (100% Free)
1. Push your commits to GitHub:
   ```bash
   git push origin main
   ```
2. In your GitHub repository:
   - Go to **Settings** $\rightarrow$ **Pages** (in the left sidebar).
   - Under **Build and deployment** > **Source**, choose **"Deploy from a branch"**.
   - Under **Branch**, select `main` and `/ (root)`, then click **Save**.
3. Within 1–2 minutes, your website will be live at:
   `https://nenduku644-hash.github.io/anudeep-deploy/`

---

### Option 3: Full Stack Backend (with WhatsApp Web Bot & MongoDB)
For automated WhatsApp sending from a server, deploy using the included `Dockerfile` and `render.yaml` to **Render.com** or **Railway**:
1. Connect your repository `nenduku644-hash/anudeep-deploy` on [render.com](https://render.com).
2. Render will automatically detect `render.yaml` and `Dockerfile` (with Chromium pre-configured).
3. Add your `MONGO_URI` environment variable and launch!