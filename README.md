**日本語** | [English](./README.en.md)

# ComfyUI-SAM3DRender

ComfyUI 用カスタムノードパッケージ。SAM 3D Objects 系の点群・3DGS 出力を **WebGL Gaussian Splatting ビューア** で開いて、構図を決めて、画像としてキャプチャするまでをノードグラフで完結させます。SAM 3D 由来の深度推定（MoGe）→ 点群 PLY 生成も同梱しています。

---

## 提供ノード

| ノード | 入力 | 出力 | 用途 |
|---|---|---|---|
| **Load SAM3D Model** | `precision`（auto/bf16/fp16/fp32） | `model` | MoGe v1 (`Ruicheng/moge-vitl`) を初回起動時に `ComfyUI/models/sam3d/` へ自動 DL し、設定 dict を出力 |
| **SAM3D Gaussian Splatting** | `model` / `image` / `filename_prefix` | `ply_path` | MoGe で深度推定 → R3→3DGS 視点変換 → ASCII 点群 PLY を `ComfyUI/output/<prefix>_<NNNNN>_.ply` に保存 |
| **Gaussian Splatting Render** | `ply_path` | `image` | 任意の `.ply`（3DGS バイナリ／ASCII 点群）を WebGL で開き、撮影範囲指定 → PNG キャプチャ |
| **Gaussian Splatting Render（SAM3D）** | `model` | `image` | ビューア内で画像を読み込んで MoGe を実行 → そのまま 3D 表示 → 撮影。サーバに PLY を残しません |

---

## インストール

ComfyUI Manager または手動で `custom_nodes/` 配下へ配置してから ComfyUI を起動するだけです。初回起動時に自動で行われる処理：

1. `comfy-env==0.1.75` をホスト venv へ pip install
2. `_env_config.py` がプラットフォームを検出して `nodes/sam3d/comfy-env.toml` を生成
3. `comfy-env` が **隔離 Python 3.12 環境** を `nodes/sam3d/_env_*` 以下に構築（torch、MoGe、utils3d、psutil、einops、tqdm、comfy-aimdo、comfy-kitchen ほか）
4. SAM3D 系ノードはこの隔離環境内 subprocess で実行され、ホストの ComfyUI venv（多くは Python 3.11）を汚染しません

### 対応プラットフォーム

`_env_config.py` の `detect_target()` が分岐：

| 検出名 | OS / アーキ | Python |
|---|---|---|
| `win-x64` | Windows AMD64 | 3.12 |
| `linux-x64` | Linux x86_64 | 3.12 |
| `dgx-spark` | Linux aarch64（Grace + GB10 など） | 3.12 |

CUDA バージョンは comfy-env がホスト側で自動検出（例：CUDA 12.8 → torch 2.8 cu128）。

### モデルファイル

| 用途 | リポジトリ | ライセンス | 配置 |
|---|---|---|---|
| MoGe v1 (point map) | `Ruicheng/moge-vitl` | Apache 2.0 / 認証不要 | `ComfyUI/models/sam3d/model.pt` |

---

## 使い方

### 1. PLY を生成して保存する（ワークフロー）

```
[Image] → [Load SAM3D Model] → [SAM3D Gaussian Splatting] → ply_path → [Gaussian Splatting Render]
                                       ↑
                                   filename_prefix で出力名を指定
```

`SAM3D Gaussian Splatting` の `filename_prefix` は ComfyUI 標準の `SaveImage` と同じ仕様（`%date%` などのトークンや `prefix/subfolder` 形式の入れ子も可）。

### 2. ビューア内で完結させる（SAM3D 版レンダラ）

```
[Load SAM3D Model] → [Gaussian Splatting Render（SAM3D）]
```

`Open Gaussian Splatting Render（SAM3D）` ボタンを押してモーダルを開き、

- **画像を読み込む** → ファイルピッカーで画像を選択 → サーバ側 subprocess で MoGe → ASCII PLY と描画用 binary PLY が**ブラウザに直接ストリーム返却**（サーバはレスポンス送信前に temp ファイルを削除）
- **撮影範囲指定** → 範囲をドラッグ → **Confirm & Close** で PNG をノードへ
- **ply保存** → ブラウザが保持する ASCII PLY を `Blob` 化してダウンロード（Blender / MeshLab / CloudCompare などで開ける標準点群）

ビューアで生成した PLY は `ComfyUI/output/` には書き出されません。同じノードのモーダルを再度開くと **直前にロードした PLY をそのまま復元** します（ComfyUI ページを開いている間のセッションキャッシュ）。

---

## ビューアの操作

| 操作 | 動作 |
|---|---|
| 左ドラッグ | 視点回転（左右＝横回転 / 上下＝縦回転、軸固定） |
| 右ドラッグ | ロール |
| 中ドラッグ | パン |
| ホイール | ズーム |
| W/A/S/D | フライ移動 / Space・Q：上 / E・X：下 |
| Shift / Ctrl | ダッシュ（×3）/ 微速（×0.3） |
| 矢印キー | 微回転 |
| R | カメラリセット |
| Ctrl+Enter | Confirm & Close |

カメラパネルから軸（Y up / -Y up / Z up / -Z up）、回転、位置、**視野角（FoV）**、ガウシアンサイズ、近距離クリップを直接編集できます。FoV / Splat Size スライダーは **マウスを離した瞬間に再描画**（ドラッグ中はカクつき防止のため反映を遅延）。

---

## ライセンス

本プロジェクトは以下 2 つの上流ライセンスを継承しています。再配布時は同梱の `LICENSE.splat` と `LICENSE.SAM` をそのまま含めてください。

| 部位 | 由来 | ライセンス |
|---|---|---|
| WebGL ビューア（`web/editor/static/main.js` など） | [antimatter15/splat](https://github.com/antimatter15/splat)（Kevin Kwok） | MIT — `LICENSE.splat` |
| 深度→PLY パイプライン（`nodes/sam3d/`） | [facebookresearch/sam-3d-objects](https://github.com/facebookresearch/sam-3d-objects)（Meta Platforms）の API ベースで再実装 | SAM License — `LICENSE.SAM` |
| 本プロジェクト固有のコード（ノードのラッパ、サーバルート、ウィジェット） | — | 一貫性のため MIT（`LICENSE.splat` の条項に従う） |

詳細は同梱の [`LICENSE`](./LICENSE) を参照してください。
