# Claude Context 项目成长记录

---

## 已完成

- [x] 仓库隔离标志由绝对路径 hash → url+分支 进行隔离

```
1. [core] 全局替换仓库隔离ID为url+branch组合Hash
2. feat(core): 仓库隔离改为基于 URL + 分支 hash
3. fix: 仓库隔离策略改为基于URL+分支，统一标识格式为冒号分隔
4. fix: url+branch 仓库隔离 + forceReindex 修复 + pnpm 11 兼容
5. fix: get_indexing_status 增加 Milvus 兜底，与 url+branch 隔离对齐
6. fix: get_indexing_status 读磁盘快照而非过期内存，与 search 对齐
7. feat: SnapshotManager 全面改为 identity (url:branch) 驱动，彻底消除绝对路径依赖
```

---

## 正在做

- [ ] 后台自动索引功能

---

## 待完成

- [ ] LDAP 集成
- [ ] GitLab 集成

---

## 卡点

（暂无）