npm install                    # 首次:装 playwright 和 xlsx
npx playwright install chrome  # 首次:让 playwright 认到 Chrome
npm run login                  # 首次:弹出浏览器,手动登录 FactSet 一次,然后关窗口
npm run fetch                  # 日常:全自动跑

npm install
npx playwright install chrome
npm run login
cd <项目文件夹>  (fetcher 的上一级)
