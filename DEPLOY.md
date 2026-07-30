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

## 零、一条命令走完（推荐）

第一～四节的全部动作已经脚本化，在**本机**跑：

```bash
cd /home/zt/claude-context-local-stack
./push-to-server.sh --dry-run      # 先看它要做什么，不连服务器不改任何东西
./push-to-server.sh                # 传文件 → 补 .env → 留底 → load → 重建 → 验证
./push-to-server.sh --verify-only  # 只跑只读验证（含"服务器上是新镜像还是旧镜像"判定）
```

密码只需输一次（脚本用 SSH ControlMaster 复用连接），配了公钥则全程免密；
`SSHPASS=<密码> ./push-to-server.sh --yes` 可全非交互（密码不进命令行）。

脚本是幂等的：`docker tag backup-<日期>` 留底、`docker compose up -d` 只重建配置变了的容器、
不 `down`、不动 `data/`。`.env` 按键分三种情形处理 —— **缺失则追加、值不同则原地更新、
一致则不动**，只碰 `ENV_KEYS` 里那几个键，人工加的其他键与注释一概不动。

> 早先的版本是"键已存在就跳过"，结果改了默认值（如 `GIT_INDEX_CONCURRENCY` 3→6）
> 永远推不到服务器上：服务器 `.env` 里已有那个键，就被当成"已是期望值"跳过了。

下面各节是同一套动作的手工版，供排查用。

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

导出到 local-stack 的 `images/`（文件名必须与 `deploy.sh` 的 `load_image` 对齐）。
覆盖前先把上一版留成 `.bak-<日期>`——回滚时不必重新构建：

```bash
cd /home/zt/claude-context-local-stack/images
mv claude-git-index.tar.gz claude-git-index.tar.gz.bak-$(date +%Y%m%d)
mv claude-phigent.tar.gz   claude-phigent.tar.gz.bak-$(date +%Y%m%d)

docker save claude-context-git-index:latest | gzip -1 > claude-git-index.tar.gz
docker save claude-phigent:latest           | gzip -1 > claude-phigent.tar.gz

# 校验 tar 完整（gzip 截断/写坏时 docker load 会在服务器上才失败）
gunzip -c claude-git-index.tar.gz | tar -tf - manifest.json
gunzip -c claude-phigent.tar.gz   | tar -tf - manifest.json
ls -lh
```

> `images/` 已 gitignore，tar 不进仓库。`gzip -1` 比默认级别快得多，
> 体积只差几个百分点（171M vs 168M），传输时间的差远小于压缩时间的差。

**当前产物**（2026-07-30 已就绪）：`claude-git-index.tar.gz` 171M（21:00 构建）、
`claude-phigent.tar.gz` 293M（22:47 构建，config `86df39d7`），
上一版留底为 `.bak-20260717` / `.bak-20260730`。

> **覆盖 tar 之前一定要核对镜像是不是刚构建的那个**。同一天翻过两次车：一次镜像
> 是 14:12 的旧构建（修复在 19:21 才提交），一次 21:55 导出的 tar 里是上一版 config。
> 两个正交的检查：
>
> ```bash
> # ① tar 里的 config digest 要等于构建日志末尾的 "exporting config sha256:…"
> gunzip -c images/claude-phigent.tar.gz | tar -xO manifest.json | grep -o 'sha256/[0-9a-f]\{12\}'
> # ② 前端产物里要真能 grep 到本次改动（先用一个必然存在的串做正对照）
> cid=$(docker create claude-phigent:latest); docker cp $cid:/app/build /tmp/pg; docker rm -f $cid
> grep -c codebasePath /tmp/pg/assets/index-*.js     # 正对照，必须 > 0
> ```
>
> 注意前端是 **Vite** 构建，产物在 `assets/index-<hash>.js`，不在 CRA 的 `static/js/`；
> 路径错了会全部 0 命中，看起来跟"修复没进去"一模一样。

## 二、上传（sftp）

镜像放 `images/`；编排文件与 `assets/` 只在有改动时才传。

```
lcd /home/zt/claude-context-local-stack/images
put claude-git-index.tar.gz  /data1/users/haoming.ju/claude-context/stack/images/claude-git-index.tar.gz
put claude-phigent.tar.gz    /data1/users/haoming.ju/claude-context/stack/images/claude-phigent.tar.gz

lcd /home/zt/claude-context-local-stack
put docker-compose.yml        /data1/users/haoming.ju/claude-context/stack/docker-compose.yml
put assets/milvus-user.yaml   /data1/users/haoming.ju/claude-context/stack/assets/milvus-user.yaml
put deploy.sh                 /data1/users/haoming.ju/claude-context/stack/deploy.sh
```

> 服务器上 `assets/` 目录此前不存在（旧栈没有 `milvus-user.yaml`），
> 传之前先 `mkdir assets`，否则 `put` 会失败。

> `assets/milvus-user.yaml` 缺失时 Docker 会在挂载点建**空目录**，Milvus 把
> `/milvus/configs/user.yaml` 当目录读会直接起不来。`deploy.sh` 已在启动前显式检查这一点。

## 三、补齐服务器 `.env`

新增的键（老 `.env` 里没有，缺了就走 compose 默认值，等于资源限制不生效）：

```bash
# 索引并发与内存回收
GIT_INDEX_CONCURRENCY=6          # 实测 embedding 吞吐饱和点：1/3/6/8/12 流 → 27/75/136/140/142 embed/s
GIT_INDEX_RELEASE_AFTER=true     # 每个 collection 写完即从 Milvus 内存 release

# 各服务资源上限（几百个仓库 × 多分支的关键防崩措施）
MILVUS_MEM_LIMIT=64g   MILVUS_CPU_LIMIT=24     # 最大消耗方；配 milvus-user.yaml 的 mmap 后实际远低于上限
OLLAMA_MEM_LIMIT=32g   OLLAMA_CPU_LIMIT=16
GIT_INDEX_MEM_LIMIT=16g GIT_INDEX_CPU_LIMIT=12 # 实测单 worker 峰值 ~1 GiB（多在堆外），并发 6 最坏 ~6 GiB
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

> **`~/.context/.env` 的 `OLLAMA_HOST` 必须是 `:11435`**（本栈发布的端口）。
> 这台机器上 `:11434` 是**他人的** Ollama（另装了十来个模型），它恰好也有
> `nomic-embed-text`、digest 相同，所以指错了照样能出向量、召回一模一样 ——
> 只是蹭了别人的推理服务，且不受我们给 ollama 设的 32g/16cpu 上限保护。
> 代价是每次搜索多 ~30–40ms（我们的 ollama 被限了 CPU），换来资源隔离。

容量参数不要照抄默认值，用两个测量脚本重新定（见 [benchmarks/](benchmarks/README.md)）：

```bash
OLLAMA_HOST=http://10.50.4.149:11435 node benchmarks/embed-throughput.mjs   # → GIT_INDEX_CONCURRENCY
node benchmarks/worker-mem.mjs /path/to/big-repo                            # → GIT_INDEX_MEM_LIMIT
```

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
