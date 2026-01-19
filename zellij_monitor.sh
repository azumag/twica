#!/bin/bash

# Zellijの現在ペーン監視スクリプト
# 現在のペーンの出力が1分以上変化していない場合、自動的に "/singlerun" を送信
# zellijを手動で開いてから、このスクリプトを実行してください

# Zellijセッション内で実行されているか確認
if [ -z "$ZELLIJ" ]; then
    echo "Error: Please run this script inside a Zellij session."
    echo "Start Zellij first with: zellij"
    exit 1
fi

DUMP_FILE="/tmp/zellij_pane_dump_$$.txt"
PREV_DUMP_FILE="/tmp/zellij_pane_dump_prev_$$.txt"
LAST_CHANGE_TIME=$(date +%s)

# クリーンアップ関数
cleanup() {
    rm -f "$DUMP_FILE" "$PREV_DUMP_FILE"
    exit 0
}

trap cleanup INT TERM EXIT

# バックグラウンドで監視を開始
(
    while true; do
        # 現在のペーンの内容をダンプ
        zellij action dump-screen "$DUMP_FILE" 2>/dev/null

        # 内容が変化したかチェック
        if [ -f "$PREV_DUMP_FILE" ]; then
            if ! diff -q "$DUMP_FILE" "$PREV_DUMP_FILE" > /dev/null 2>&1; then
                # 内容が変化した
                LAST_CHANGE_TIME=$(date +%s)
            else
                # 内容が変化していない
                CURRENT_TIME=$(date +%s)
                ELAPSED=$((CURRENT_TIME - LAST_CHANGE_TIME))

                if [ $ELAPSED -ge 60 ]; then
                    # 現在のペーンにコマンド送信
                    zellij action write-chars "/singlerun"
                    zellij action write 32
                    sleep 1.5
                    zellij action write 13

                    # タイマーをリセット
                    LAST_CHANGE_TIME=$(date +%s)
                fi
            fi
        fi

        # 現在のダンプを保存
        cp "$DUMP_FILE" "$PREV_DUMP_FILE" 2>/dev/null

        # 5秒待つ
        sleep 5
    done
) &

# opencodeを起動（フォアグラウンド）
exec opencode
