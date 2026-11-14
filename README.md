# tweetapp-to-bsky

`app.tweet.app` から Bluesky へ同時にクロスポストするための Userscript です。

## 主な機能

- **テキスト・Facet 変換**: ハッシュタグや URL を Bluesky のリッチテキスト（Facet）として自動リンク化
- **画像クロスポスト（最大5枚）**: `app.bsky.embed.gallery` を使用し、1〜5枚の画像を一括投稿
- **動画クロスポスト**: 動画添付時に `video.bsky.app` 経由でアップロード
- **OGP リンクカード自動生成**: URL を含むテキスト投稿時にタイトル・説明文・サムネイルを取得して外部リンクカードを添付（YouTube / X の oEmbed にも対応）
- **ワンクリック切り替え**: 投稿フォームの送信ボタン横に `Bluesky` チェックボックスと設定ボタン（⚙）を追加

## インストール

1. お使いのブラウザに Userscript マネージャーをインストールします。
   - **Safari (macOS / iPadOS / iOS)**: [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)
   - **Chrome / Edge / Firefox**: [Tampermonkey](https://www.tampermonkey.net/) または [Violentmonkey](https://violentmonkey.github.io/)
2. 以下の Raw URL を開くか、スクリプト内容を新規作成して保存します。
   - `https://raw.githubusercontent.com/imgddotnet/tweetapp-to-bsky/main/tweetapp-to-bsky.user.js`

## 設定方法

1. `https://app.tweet.app/` を開きます。
2. サイドメニューの **Bluesky** または投稿欄の歯車アイコン（**⚙**）をクリックします。
3. 以下の情報を入力して **Save** を押します。
   - **PDS URL**: 利用している PDS の URL（標準は `https://bsky.social`）
   - **Handle**: Bluesky のハンドル（例: `user.bsky.social`）
   - **App Password**: Bluesky の設定画面から発行したアプリパスワード

## 仕様・制限事項

- このスクリプトは無保証、無サポートです。
- コード作成に生成AIを使用しており、バージョンアップ等に時間を要する場合があります。
- **画像**: 最大5枚まで対応、tweet.appの仕様に準じます。
- **動画**: tweet.appの仕様に準じます。

## ライセンス

[MIT License](LICENSE)





# tweetapp-to-bsky

A userscript to crosspost simultaneously from `app.tweet.app` to Bluesky.

## Features

- **Text & Facet Conversion**: Automatically converts hashtags and URLs into Bluesky rich text facets.
- **Image Crossposting (Up to 5 Images)**: Uses `app.bsky.embed.gallery` to post 1 to 5 images at once.
- **Video Crossposting**: Uploads attached videos via `video.bsky.app`.
- **Automatic OGP Link Cards**: Fetches titles, descriptions, and thumbnails for URLs in posts to attach external link cards (also supports YouTube and X oEmbed).
- **One-Click Toggle**: Adds a `Bluesky` checkbox and a settings button (⚙) next to the compose submit button.

## Installation

1. Install a userscript manager in your browser:
   - **Safari (macOS / iPadOS / iOS)**: [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)
   - **Chrome / Edge / Firefox**: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Open the Raw URL below to install, or create a new script and paste the code:
   - `https://raw.githubusercontent.com/imgddotnet/tweetapp-to-bsky/main/tweetapp-to-bsky.user.js`

## Setup

1. Open `https://app.tweet.app/`.
2. Click **Bluesky** in the side menu or the gear icon (**⚙**) in the compose box.
3. Enter your credentials and click **Save**:
   - **PDS URL**: Your PDS URL (defaults to `https://bsky.social`)
   - **Handle**: Your Bluesky handle (e.g., `user.bsky.social`)
   - **App Password**: An App Password generated in your Bluesky settings

## Specifications & Limitations

- This script is provided as-is, without warranty or support.
- Generative AI was used to write this code, so updates and maintenance may take some time.
- **Images**: Supports up to 5 images, subject to `tweet.app`'s specifications.
- **Videos**: Subject to `tweet.app`'s specifications.

## License

[MIT License](LICENSE)
