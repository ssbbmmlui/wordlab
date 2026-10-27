# 一鍵：push 分支 → 開 PR →（可選）合併 → 啟用 GitHub Pages
# 前置：token 放在 $env:TEMP\gh-token.txt
#   建議 Fine-grained token：Contents、Pull requests、Pages 都給 Read and write
#   或 Classic token：repo、workflow
# 用法：
#   pwsh -File scripts/github-release.ps1              # 只 push + 開 PR（你自己合併）
#   pwsh -File scripts/github-release.ps1 -Merge       # 開完 PR 直接合併到 main
#   pwsh -File scripts/github-release.ps1 -Merge -EnablePages
param(
  [string]$Owner = 'ssbbmmlui',
  [string]$Repo = 'wordlab',
  [string]$Branch = 'feature/wordlab-v1.1.0',
  [string]$Base = 'main',
  [switch]$Merge,
  [switch]$EnablePages
)

$ErrorActionPreference = 'Stop'
$tokenPath = Join-Path $env:TEMP 'gh-token.txt'
if (-not (Test-Path $tokenPath)) {
  throw "找不到 token 檔：$tokenPath。請先執行：Set-Content -Path `"$tokenPath`" -Value `"<token>`" -NoNewline"
}
$token = (Get-Content $tokenPath -Raw).Trim()
if (-not $token) { throw 'token 檔是空的' }

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'wordlab-release-script'
}
$api = "https://api.github.com/repos/$Owner/$Repo"

function Invoke-GitHub {
  param([string]$Method, [string]$Url, $Body)
  $params = @{ Method = $Method; Uri = $Url; Headers = $headers; ErrorAction = 'Stop' }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 10)
    $params.ContentType = 'application/json'
  }
  Invoke-RestMethod @params
}

$repoInfo = Invoke-GitHub -Method GET -Url $api
Write-Host "repo: $($repoInfo.full_name) · default branch: $($repoInfo.default_branch)"
$ownerLogin = $repoInfo.owner.login
$repoName = $repoInfo.name

# ── 1. push 分支 ────────────────────────────────────────────────
Write-Host "`n[1/4] push $Branch ..."
git push "https://x-access-token:$token@github.com/$ownerLogin/$repoName.git" "$Branch:$Branch"
if ($LASTEXITCODE -ne 0) { throw 'git push 失敗（請確認 token 有 Contents: read and write）' }

# ── 2. 建立 PR ─────────────────────────────────────────────────
Write-Host "`n[2/4] 建立 PR ..."
$prBody = @'
## 這個 PR 做了什麼

把完整的 **WordLab 單詞工坊** 加進 repository，並設定 **合併到 main 後自動部署到 GitHub Pages**。

### App 功能
- **496 個英文單詞**，四個難度：基礎 151 / 中階 210 / 進階 75 / 高階 60
- 間隔重複（SRS）學習卡片：忘記 / 普通 / 熟記，自動排下次複習；每日目標；只複習到期的
- 五種測驗：混合、看詞選義、看義選詞、拼寫、聽力（Web Speech API），答錯自動排回複習
- 進度儀表板：連續天數、掌握度、難度分布、14 天複習量、12 週學習熱力圖、測驗紀錄
- 496 詞可搜尋單詞庫（難度／狀態篩選）＋單詞詳情
- 設定：名字、每日目標、新單詞難度、美式／英式發音、匯出／匯入進度 JSON
- 純前端、離線可用，資料只存在瀏覽器 localStorage

### 修正
- 學習足跡熱力圖溢出面板：改為 12×7 明確網格，加上星期標籤、今天標記與統計footer

### 自動部署
- `.github/workflows/deploy.yml`：每次 push（合併 PR）到 `main` → 驗證資料 → 建置 `_site` → 部署 GitHub Pages
- `scripts/build.mjs`：驗證 496 筆資料（必填欄位／重複／音標／難度）並輸出靜態網站
- `scripts/smoke-test.mjs`：無頭瀏覽器端到端檢查（16/16 通過）

### 測試
```
node scripts/build.mjs        # ✔ 496 words, validate ok
node scripts/smoke-test.mjs   # 16/16 passed
```
'@
$pr = Invoke-GitHub -Method POST -Url "$api/pulls" -Body @{
  title = 'feat: WordLab 單詞工坊 v1.1.0 — 496 詞學習 App + GitHub Pages 自動部署'
  head  = $Branch
  base  = $Base
  body  = $prBody
  draft = $false
}
Write-Host "PR #$($pr.number): $($pr.html_url)"

# ── 3.（可選）合併 PR ──────────────────────────────────────────
if ($Merge) {
  Write-Host "`n[3/4] 合併 PR #$($pr.number) ..."
  $merged = Invoke-GitHub -Method PUT -Url "$api/pulls/$($pr.number)/merge" -Body @{
    commit_title   = "Merge pull request #$($pr.number) from $Branch"
    commit_message = 'WordLab v1.1.0 — 496 words, 4 levels, progress dashboard, auto-deploy'
    merge_method   = 'squash'
  }
  Write-Host "merged: $($merged.merged) · sha: $($merged.sha)"
} else {
  Write-Host "`n[3/4] 略過合併（你自己在 GitHub 按 Merge）"
}

# ── 4.（可選）啟用 GitHub Pages ────────────────────────────────
if ($EnablePages) {
  Write-Host "`n[4/4] 啟用 GitHub Pages（Source: GitHub Actions）..."
  try {
    Invoke-GitHub -Method POST -Url "$api/pages" -Body @{ build_type = 'workflow' } | Out-Null
    Write-Host 'Pages 已啟用（workflow build_type）'
  } catch {
    $msg = $_.ErrorDetails.Message
    if ($msg -match '409') {
      Invoke-GitHub -Method PUT -Url "$api/pages" -Body @{ build_type = 'workflow' } | Out-Null
      Write-Host 'Pages 已更新為 workflow 模式'
    } else {
      Write-Host "啟用 Pages 失敗（可能 token 沒有 Pages 權限）：$msg"
      Write-Host '請到 GitHub → Settings → Pages → Source 選「GitHub Actions」'
    }
  }
  try {
    $site = Invoke-GitHub -Method GET -Url "$api/pages"
    Write-Host "網站：$($site.html_url)"
  } catch { }
} else {
  Write-Host "`n[4/4] 略過 Pages 設定"
}

Write-Host "`n完成。PR: $($pr.html_url)"
