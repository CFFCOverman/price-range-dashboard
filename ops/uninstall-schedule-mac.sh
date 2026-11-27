#!/bin/bash
# macOS:撤掉两个 launchd 计划任务
for l in com.pricerange.collect com.pricerange.options-oi; do
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/$l.plist" && echo "已撤掉 $l"
done
