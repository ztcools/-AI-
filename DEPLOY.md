# 云端 git-index-service 部署清单（10.50.4.149）

> 目的：让"保护分支"功能在云端生效（新版 git-index-service 支持 main + protectedBranches 索引 + /branches 列分支 API）。
> 影响：重启 `claude-git-index` 单个容器，期间定时索引暂停（~几分钟）。Milvus/Ollama/PhiGent 不动。
> 守卫：同机有 30+ 他人容器，**绝不 `docker image prune`**，只按精确 ID 删自己置换出的旧镜像；数据卷 `data/` 绝不动。

## 前置
- 本地能连服务器（SSH：`haoming.ju@10.50.4.149`，密码经 `SRVPW` 环境变量传入）。
- 本地构建需美国代理：`--build-arg HTTP_PROXY=http://127.0.0.1:7897 --build-arg HTTPS_PROXY=http://127.0.0.1:7897 --network=host`（NO_PROXY 含 registry.npmmirror.com）。
- 服务器栈目录：`/data1/users/haoming.ju/claude-context/stack/`（compose + .env + images/ + data/）。

## 步骤

### 1. 本地构建镜像（仓库根，带代理）
```bash
cd /home/zt/context
docker build \
  -f packages/git-index-service/Dockerfile \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  --network=host \
  -t claude-context-git-index:latest .
```

### 2. 导出镜像
```bash
docker save claude-context-git-index:latest | gzip > /tmp/git-index.tar.gz
ls -lh /tmp/git-index.tar.gz
```

### 3. 上传到服务器
```bash
# 用记忆里的 paramiko venv（/tmp/sshenv）的 put.py，或 sftp
sftp haoming.ju@10.50.4.149
> put /tmp/git-index.tar.gz /data1/users/haoming.ju/claude-context/stack/images/git-index.tar.gz
```

### 4. 服务器加载镜像并只重启 git-index（不动他人容器、不动 data/）
```bash
ssh haoming.ju@10.50.4.149
cd /data1/users/haoming.ju/claude-context/stack
gunzip -c images/git-index.tar.gz | docker load
docker compose up -d git-index        # 只重建 git-index 一个服务
docker ps | grep claude-git-index     # 确认起来了
```

### 5. 验证
```bash
curl -s http://10.50.4.149:8795/health                       # {"status":"ok"}
curl -s http://10.50.4.149:8795/repos                        # 仓库列表（含 protectedBranches 字段）
curl -s "http://10.50.4.149:8795/branches?name=pipeline"     # 新增：列出 pipeline 远程分支（link 的候选来源）
```

## 给仓库配保护分支（生效关键）
现在云端仓库还是老的单 main 配置。通过 PhiGent 控制台「GitLab 仓库」页（二级分层新版）编辑仓库，填入保护分支（逗号分隔），或直接调 API：
```bash
curl -X PUT http://10.50.4.149:8795/repos/pipeline \
  -H 'Content-Type: application/json' \
  -d '{"protectedBranches":["dev","release/1.0"]}'
curl -X POST http://10.50.4.149:8795/index/pipeline   # 触发 main+所有保护分支索引
```
配好后，开发者本地 `/seeway-link` 就能列出并链接这些保护分支。

## 回滚
镜像 tag 没变（latest），旧镜像已被替换。回滚需旧镜像 ID（部署前 `docker images | grep git-index` 记下）。最稳妥：部署前在服务器 `docker tag claude-context-git-index:latest claude-context-git-index:backup-$(date +%Y%m%d)` 留底，回滚时 `docker tag backup latest && docker compose up -d git-index`。
