# 部署清单（云端 10.50.4.149）

本仓库产出两类东西，部署路径不同：

| 产物 | 跑在哪 | 怎么装 |
|------|--------|--------|
| MCP 服务（`packages/mcp`） | **开发者本机** | `./install.sh`，见 [README](README.md#安装) |
| git-index-service 镜像（`packages/git-index-service`） | **服务器容器** | 本文 |

服务器上的容器编排（Milvus/MinIO/etcd/Ollama/git-index/PhiGent）由独立仓库
[`claude-context-local-stack`](../claude-context-local-stack) 管理，本地路径 `/home/zt/claude-context-local-stack`。
本文只讲"把本仓库改动送上服务器"这条链路。

> **守卫（每次都要遵守）**
> - 同机有 30+ 他人容器：**绝不 `docker image prune` / `docker system prune`**，只按精确 ID 删自己置换出的旧镜像。
> - 数据卷 `data/`（etcd/minio/milvus/ollama/git-index repos）**绝不动**。
> - 只重建自己的服务（`git-index` / `phigent`），不 `docker compose down` 整栈。
> - 只在 `haoming.ju` 用户下操作，无 sudo。

## 前置

- SSH：`haoming.ju@10.50.4.149`（密码经 `SRVPW` 环境变量传入，不写进命令行历史）。
- 本地构建需美国代理：
  `--build-arg HTTP_PROXY=http://127.0.0.1:7897 --build-arg HTTPS_PROXY=http://127.0.0.1:7897 --network=host`
  （`NO_PROXY` 含 `registry.npmmirror.com`）。
- 服务器栈目录：`/data1/users/haoming.ju/claude-context/stack/`
  （`docker-compose.yml` + `.env` + `assets/` + `images/` + `data/`）。

## 一、构建镜像（本地）

```bash
# git-index-service（来自本仓库）
cd /home/zt/context
docker build \
  -f packages/git-index-service/Dockerfile \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  --network=host \
  -t claude-context-git-index:latest .

# PhiGent 控制台（来自 /home/zt/PhiGent，仅当控制台有改动时才需要）
cd /home/zt/PhiGent
docker build \
  --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
  --network=host \
  -t claude-phigent:latest .
```

导出（文件名必须与 `deploy.sh` 的 `load_image` 对齐）：

```bash
docker save claude-context-git-index:latest | gzip > /tmp/claude-git-index.tar.gz
docker save claude-phigent:latest          | gzip > /tmp/claude-phigent.tar.gz
ls -lh /tmp/claude-*.tar.gz
```

## 二、上传（sftp）

镜像放 `images/`；编排文件与 `assets/` 只在有改动时才传。

```
put /tmp/claude-git-index.tar.gz  /data1/users/haoming.ju/claude-context/stack/images/claude-git-index.tar.gz
put /tmp/claude-phigent.tar.gz    /data1/users/haoming.ju/claude-context/stack/images/claude-phigent.tar.gz
put /home/zt/claude-context-local-stack/docker-compose.yml        .../stack/docker-compose.yml
put /home/zt/claude-context-local-stack/assets/milvus-user.yaml   .../stack/assets/milvus-user.yaml
put /home/zt/claude-context-local-stack/deploy.sh                 .../stack/deploy.sh
```

> `assets/milvus-user.yaml` 缺失时 Docker 会在挂载点建**空目录**，Milvus 把
> `/milvus/configs/user.yaml` 当目录读会直接起不来。`deploy.sh` 已在启动前显式检查这一点。

## 三、补齐服务器 `.env`

新增的键（老 `.env` 里没有，缺了就走 compose 默认值，等于资源限制不生效）：

```bash
# 索引并发与内存回收
GIT_INDEX_CONCURRENCY=3          # 瓶颈是 Ollama 向量化，超过 OLLAMA_NUM_PARALLEL 只会互相排队
GIT_INDEX_RELEASE_AFTER=true     # 每个 collection 写完即从 Milvus 内存 release

# 各服务资源上限（几百个仓库 × 多分支的关键防崩措施）
MILVUS_MEM_LIMIT=64g   MILVUS_CPU_LIMIT=24     # 最大消耗方；配 milvus-user.yaml 的 mmap 后实际远低于上限
OLLAMA_MEM_LIMIT=32g   OLLAMA_CPU_LIMIT=16
GIT_INDEX_MEM_LIMIT=16g GIT_INDEX_CPU_LIMIT=12 # 约每个 worker 4~5 GiB，调 CONCURRENCY 时同步上调
MINIO_MEM_LIMIT=8g     MINIO_CPU_LIMIT=4
ETCD_MEM_LIMIT=4g      ETCD_CPU_LIMIT=2
PHIGENT_MEM_LIMIT=2g   PHIGENT_CPU_LIMIT=2
```

完整模板见 `claude-context-local-stack/.env.example`。

## 四、加载镜像并重建（只动自己的服务）

```bash
ssh haoming.ju@10.50.4.149
cd /data1/users/haoming.ju/claude-context/stack

# 留底，回滚要用
docker tag claude-context-git-index:latest claude-context-git-index:backup-$(date +%Y%m%d)
docker tag claude-phigent:latest           claude-phigent:backup-$(date +%Y%m%d)

gunzip -c images/claude-git-index.tar.gz | docker load
gunzip -c images/claude-phigent.tar.gz   | docker load

docker compose up -d git-index phigent    # 只重建这两个
```

**资源上限与 mmap 需要重建对应容器才生效**，改了 `docker-compose.yml` 的 `deploy.resources`
或 `assets/milvus-user.yaml` 之后必须：

```bash
docker compose up -d standalone           # Milvus：重建才会读到新的 user.yaml 与新上限
docker compose up -d ollama minio etcd    # 仅当动了它们的上限
```

> 不需要 `down`。`up -d <service>` 只重建配置变了的那几个容器，他人容器不受影响。

## 五、验证

```bash
# 容器与实际生效的上限
docker compose ps
docker inspect claude-milvus-standalone --format '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'

# 服务健康
curl -s http://10.50.4.149:9091/healthz                      # Milvus: OK
curl -s http://10.50.4.149:8795/health                       # {"status":"ok"}
curl -s http://10.50.4.149:8795/repos                        # 仓库列表（含 protectedBranches）
curl -s "http://10.50.4.149:8795/branches?name=pipeline"     # link 的候选分支来源
docker exec claude-ollama ollama list                        # nomic-embed-text 就位

# mmap 生效（Milvus 内存不再随 collection 数线性涨）
docker stats --no-stream claude-milvus-standalone
```

客户端侧端到端验证：在任一被索引的仓库里 `link` → `search`，或跑
`node benchmarks/harness.mjs <repo> main benchmarks/scenarios/ap-client-api.json`（见 [benchmarks/](benchmarks/README.md)）。

## 六、给仓库配保护分支

在 PhiGent 控制台「代码仓库」页编辑（支持华为云 CodeHub / GitLab / GitHub，按填入的 URL 自动区分认证方式），
或直接调 API：

```bash
curl -X PUT http://10.50.4.149:8795/repos/pipeline \
  -H 'Content-Type: application/json' \
  -d '{"protectedBranches":["dev","release/1.0"]}'
curl -X POST http://10.50.4.149:8795/index/pipeline   # 触发 main + 所有保护分支索引
```

配好后开发者本地 `/seeway-link` 就能列出并链接这些分支。

## 七、回滚

镜像 tag 不变（`latest`），所以回滚依赖第四步留下的 `backup-<date>` tag：

```bash
docker tag claude-context-git-index:backup-20260730 claude-context-git-index:latest
docker compose up -d git-index
```

编排文件回滚：`claude-context-local-stack` 里 `git checkout <旧 commit> -- docker-compose.yml` 后重新上传。
