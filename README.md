# 蒙恩水電保險管理平台

水電費用追蹤、趨勢圖表、保險到期警示的內部管理工具。

## 技術架構

| 項目 | 選用 |
|------|------|
| 前端 | 純 HTML / CSS / JS（無框架） |
| 資料庫 | Supabase（PostgreSQL） |
| 部署 | GitHub Pages（自動 CI/CD） |

---

## 部署步驟

### 1. 建立 Supabase 資料庫

1. 前往 [supabase.com](https://supabase.com) 建立新專案
2. 進入 **SQL Editor**，複製貼上 `supabase_schema.sql` 全部內容並執行
3. 執行完成後，到 **Project Settings → API** 取得：
   - `Project URL`（形如 `https://xxxx.supabase.co`）
   - `anon public` Key

### 2. 填入設定

編輯 `config.js`，將兩個值替換為你的 Supabase 資訊：

```js
const SUPABASE_URL = 'https://your-project-id.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-public-key-here';
```

### 3. 推送至 GitHub

```bash
git init
git add .
git commit -m "init: 水電保險管理平台"
git remote add origin https://github.com/你的帳號/utility-platform.git
git push -u origin main
```

### 4. 開啟 GitHub Pages

1. GitHub repo → **Settings → Pages**
2. Source 選 **GitHub Actions**
3. 推送後約 1 分鐘自動部署完成
4. 網址為：`https://你的帳號.github.io/utility-platform/`

---

## 檔案結構

```
utility-platform/
├── index.html              # 主頁面
├── style.css               # 樣式
├── app.js                  # 所有邏輯（含 Supabase 資料存取）
├── config.js               # Supabase URL & Key（需自行填入）
├── supabase_schema.sql     # 資料庫建表 SQL
└── .github/
    └── workflows/
        └── deploy.yml      # GitHub Actions 自動部署
```

---

## 功能說明

| 頁籤 | 功能 |
|------|------|
| 儀表板 | 水電趨勢折線圖、各廠區彙總、保險到期警示 |
| 輸入水電 | 按廠區 + 期別輸入用電度數與水費 |
| 保險追蹤 | 到期日警示，自訂預警天數 |
| 廠區管理 | 彈性新增 / 刪除廠區，設定計費週期 |
| 匯入/匯出 | 下載 CSV 範本、批次匯入、匯出備份 |

---

## 注意事項

- `config.js` 內含 Supabase Anon Key，此 key 為公開讀寫權限，適合內部使用
- 若需限制存取，可在 Supabase RLS 政策中加入 IP 白名單或改為需要 Auth
- 資料儲存於 Supabase，關閉瀏覽器後資料不遺失


  
