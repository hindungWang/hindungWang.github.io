---
title: Prometheus性能压测与高可用设计
date: 2023-09-01 09:40:50
description: 压一压Prometheus
tags:
  - Prometheus
---


# Prometheus性能压测与高可用设计

## Prometheus原理

### 名词

**Series（系列）** 是指具有相同标签集的一组时间序列。它们是根据标签的组合唯一确定的。`<指标名称>{<标签键>=<标签值>, ...}`，如：
```
|<------------------------Series-------------------------->|
avalanche_metric_0_0{cycle_id="0",label_key_0="label_val_0"} 18
```

**Sample（样本）** 是指一个数据点，它包含了一个时间戳和相应的数值。样本是 Prometheus 时间序列数据的基本单位。每个样本都与一个唯一的时间序列(Series)标识符相关联，该标识符由一组键值对（标签）唯一确定。这些标签可以用来标识和区分不同的时间序列。`<时间戳> <数值>`，如：
```
|<------------------------------Series-------------------->|<--时间戳->|<值>
avalanche_metric_0_0{cycle_id="0",label_key_0="label_val_0"} @125465645  2   -> 一个Sample
                                                             @125465646  5
                                                             ...
```

## Prometheus缺点

原生Prometheus并不支持高可用，也不能做横向扩缩容，当集群规模较大时，单一Prometheus会出现性能瓶颈，无法正常采集数据。

在集群场景下 单一Prometheus只能查询本地的指标，而不能跨区域查询，因此需要一个统一的管理。

## 单节点Prometheus性能压测

### 压测环境

garden v3.2 3节点环境:
| 节点      | CPU(Core)  | Memory(GiB) | 存储  | IOPS |  写速率(1MB)  |
| ----------- | ----------- |----------- | ---- | -------| ----- |
| master01          | 8      | 16GiB  | 280GiB  |   261      | 10.6 MB/s   |
| master02          | 8      | 24GiB  | 280GiB  |   238       |  9.6 MB/s   |
| master03(Prometheus所在节点)     | 8      | 24GiB  | 280GiB  |  274   |  9.5 MB/s  |

组件版本：

| 组件      | Version  |
| ----------- | ----------- |
| prometheus  | v2.15.2     |
| thanos      | v0.32.1     |
| grafana     | v10.1.0     |
| prometheus-config-reloader| v0.35.0    |
| avalanche   | v0.4.0      |

avalanche是一个Prometheus压测工具，可以生成特定series个数的merics。

target数量可以根据ServiceMonitor进行模拟。

同理也可以模拟ServiceDiscovery的个数。


### 观测方法

使用Grafana对接Prometheus数据源，引用社区看板，并且使用garden集群自带的监控观察Prometheus的内存和cpu使用率，以及所在节点数据：

- 内存+cpu
- 所在节点监控
- Prometheus自身看板

全天监控结果(中断部分为节点 down 机)：
![2.png](https://hindung.oss-cn-beijing.aliyuncs.com/img/2.png)



### 压测方法

了解Prometheus原理之后主要需要探究以下内容：

- k8s环境下Service Discovery（服务发现）个数与负载的关系
- target数目对负载的关系
- series规模和负载的关系

#### 服务发现相关性

数据结果：

sd与endpoint比例：1:1 (0/1 active targets)

| sd数量       | CPU(Core)  | Memory |
| ----------- | ----------- |----------- |
| 50          | 0.0068      | 67.9MiB    |
| 100         | 0.0054      | 83.8MiB    |
| 400         | 0.0131      | 120MiB     |
| 800         | 0.0061      | 249MiB     |
| 3000        | 0.0312      | 620MiB     |
| 5000        | 0.0569      | 2.46GiB    |

**5000个sd时prometheus-config-reloader不停重启，导致Prometheus重启，无法观测**

sd与endpoint比例：1:51 (0/51 active targets)

| sd数量       | CPU(Core)  | Memory |
| ------------ | ----------- |--------- |
| 50           |   0.0093    |  104MiB  |
| 100          |   0.0439    |  113MiB  |
| 400          |   0.0060    |  210MiB  |
| 800          |   0.0772    |  398MiB  |
| 3000         |   0.2570    |  5.04GiB |

sd与endpoint比例：1:101 (1/101 active targets)

| sd数量       | CPU(Core)  | Memory |
| ----------- | ----------- |----------- |
| 50          |   0.0189    | 171MiB  |
| 100         |   0.0499      |  130MiB |
| 400         |   0.0829    |  1.09GiB |
| 800         |    0.0917     |  601MiB |
| 3000         |    0.101     |  8.58GiB |

sd与endpoint比例成正比(与卡中心问题场景差不多):

| sd数量       | CPU(Core)  | Memory |
| ----------- | ----------- |----------- |
| 50          |   -    | -  |
| 100         |   -      |  - |
| 400         |   0.2950    |  2.52GiB |
| 800         |   0.1670      |  3.32GiB |
| 1000         |   0.1500      |  6.10GiB |
| 1500         |   2.55     |  12.0GiB |
| 3000         |    down     |  down |

**3000个sd时节点挂了，无法正常观测**

总结：sd个数与target组合不当可能会导致内存和cpu暴涨，所以使用servicemonitor进行target设置时，应该避免过多的sd配置，可以将同一个sd配置合并成为一个。

相关issue：
- [https://github.com/prometheus/prometheus/issues/8392](https://github.com/prometheus/prometheus/issues/8392)  
- [https://github.com/prometheus/prometheus/issues/8014](https://github.com/prometheus/prometheus/issues/8014)

#### target相关性

这里将sd合并成一个，观察target，数据结果：

| target       | CPU(Core)  | Memory |
| ----------- | ----------- |----------- |
| 1k          |   0.0238    | 250MiB |
| 3k         |   0.0734      |  516MiB |
| 5k         |   0.0925      |  1.45GiB |
| 1w         |   0.194      |  2.79GiB |
| 5w         |   0.870     |  10.8GiB |

总结：target数量影响负载不大，一般不会成为瓶颈，一般来说5k target已经是很巨大的集群规模了

#### series相关性

数据结果：

| series       | CPU(Core)  | Memory |
| ----------- | ----------- |----------- |
| 1k          |   0.0046    | 73.2MiB |
| 1w          |   0.0062    | 90MiB  |
| 10w          |  0.0101    | 275MiB |
| 100w         |  0.0615    |  2.27GiB  |
| 300w         |  0.5490     | 8.29GiB |
| 500w         |   down    |  down |
| 1000w        |    -   | - |

总结：500w时内存暴增；大约 500 个节点以上集群的指标会出现内存增大

*注：目前在开发环境，三个节点的k8s集群总共有180k series，预计每个节点约60k series*

## Thanos高可用方案以及性能压测

### Thanos原理

Thanos核心原理就是采用数据冗余的方式，部署多个Prometheus实例，然后将Prometheus产生的数据打散（或者说备份）至每个组件，最后使用ObjectStorage存储起来。
查询时，使用Query组件遍历其他组件将数据清理、合并、打分等操作提供给Query-Frontend。

组件及其功能：[https://thanos.io/tip/thanos/getting-started.md/#get-thanos](https://thanos.io/tip/thanos/getting-started.md/#get-thanos)

### Thanos部署以及测试准备

- Prometheus使用prometheus-operator部署
- Thanos使用thanos chart包部署

架构如下：

*Receiver模式*

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/receive.png)

*Sidecar模式*

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/sidecar.png)


### 观测方法

[thanos-component](http://grafana.cloud-infra.192.168.231.116.nip.io/d/200ac8fdbfbb74b39aff88118se4d1c2c/thanos-component?orgId=1&refresh=1m)

[prometheus-overview](http://grafana.cloud-infra.192.168.231.116.nip.io/d/e5250d32-14b3-47c1-ab5b-bb493a342f42/prometheus-overview?orgId=1&refresh=60s)

[thanos-query](http://grafana.cloud-infra.192.168.231.116.nip.io/d/af36c91291a603f1d9fbdabdd127ac4a/thanos-query?orgId=1&refresh=10s)

更多看板：http://grafana.cloud-infra.192.168.231.116.nip.io/dashboards


## Receiver模式

### 压测方法

#### 100w series

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/100w.png)

#### 200w series

**3个节点都挂了**，部分数据：
![](https://hindung.oss-cn-beijing.aliyuncs.com/img/200w.png)


#### 磁盘使用情况
100w series，观察结果：

```
*********Thu Sep  7 02:18:48 UTC 2023*********
21.7M   ./wal/checkpoint.00000097
2.0G    ./wal  # 预写文件
499.8M  ./chunks_head  # 内存映射
190.0M  ./01H9NQ489F8DSPAMZ903ZF75Q2/chunks
337.7M  ./01H9NQ489F8DSPAMZ903ZF75Q2       # 归档的块
176.0M  ./01H9P4PYA1RSA377DA7S420F58/chunks
323.4M  ./01H9P4PYA1RSA377DA7S420F58
158.6M  ./01H9PBJNJ70FD49RKJ5MGRWYKA/chunks
306.0M  ./01H9PBJNJ70FD49RKJ5MGRWYKA
490.7M  ./01H9PBR3G3WZ2WP57GM0CTYH3R/chunks
676.1M  ./01H9PBR3G3WZ2WP57GM0CTYH3R
154.2M  ./01H9PJEDATJYD2R84YHD3GCXNT/chunks
301.5M  ./01H9PJEDATJYD2R84YHD3GCXNT
4.4G    .
```

minio上的存储：
```
[root@master01 minio_5]# du -sh thanos/
4.9G    thanos/
```

主要变化的是./wal文件，类似 01H9NQ489F8DSPAMZ903ZF75Q2 这样的文件夹是用于存储已归档的数据块的。

每个文件夹都代表一个数据块，其中包含一段时间范围内的时间序列数据。Prometheus默认按2小时一个block进行存储。

因此可以算出每个块的平均大小是`(337.7+323.4+306.0+676.1+301.5)/5 = 388.94MB`

*也就是100w series，采集频率30s，每两小时大概产生400MB的存储*

### 高可用测试

#### 随机down一个节点

stop master02 观察grafana是否还有实时数据：
```
# kubectl get node -owide
NAME       STATUS     ROLES                      AGE   VERSION   INTERNAL-IP       EXTERNAL-IP   OS-IMAGE                KERNEL-VERSION           CONTAINER-RUNTIME
master01   Ready      controlplane,etcd,worker   98d   v1.23.6   192.168.231.112   <none>        CentOS Linux 7 (Core)   3.10.0-1160.el7.x86_64   docker://20.10.5
master02   NotReady   controlplane,etcd,worker   98d   v1.23.6   192.168.231.113   <none>        CentOS Linux 7 (Core)   3.10.0-1160.el7.x86_64   docker://20.10.5
master03   Ready      controlplane,etcd,worker   98d   v1.23.6   192.168.231.114   <none>        CentOS Linux 7 (Core)   3.10.0-1160.el7.x86_64   docker://20.10.5
```

节点监控：
![](https://hindung.oss-cn-beijing.aliyuncs.com/img/down-master02-node.png)

Prometheus监控：
![](https://hindung.oss-cn-beijing.aliyuncs.com/img/down-master02-pro.png)

Thanos组件监控：
![](https://hindung.oss-cn-beijing.aliyuncs.com/img/down.png)

#### 总结

停掉一个节点也能保持监控不断，就不必说随机停掉一个POD的结果了，因此，正常情况下Receiver模式能够很好做到HA。

历史数据出现缺失是因为挂掉的节点正好存储了那一部分的数据，没来得及存储到minio，但是不影响最新的数据，等节点启动会恢复该段数据。（可以引入compactor组件解决）

这是最接近无状态的方法，远程写入具有其他风险和后果，即使崩溃，也会在积极情况下丢失几秒钟的指标数据。

*但是使用Receiver模式占用的资源很大，组件多，从监控上看整个HA大概需要30+GiB内存和3+Core CPU*

## Sidecar模式

### 压测方法

#### 100w series

资源使用情况：

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/sidecar-100w.png)

*相比Receiver模式，Sidecar模式使用更少的组件，因此占用资源更少*

#### 200w series

资源使用情况：

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/sidecar-200w.png)

#### 300w series

资源使用情况：

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/sidecar-300w.png)

*由于查询走的是Thanos的Query，因此也很快P99在300ms以内*

#### 400w series

资源使用情况：

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/sidecar-400w.png)

#### 500w series

节点挂了，只获得部分数据：

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/sidecar-500w.png)

*单节点测试时500w series同样会有这样的问题*

### 高可用测试

#### 随机down一个节点

上面压测将mater02打挂了，但是监控依然在：
![](https://hindung.oss-cn-beijing.aliyuncs.com/img/sidecar-down-master02-node.png)

其他组件监控：
![](https://hindung.oss-cn-beijing.aliyuncs.com/img/sidecar-down-api-server.png)


#### 总结

这并不意味着Prometheus可以完全无状态，因为如果崩溃并重新启动，将会丢失约2小时的指标数据，因此强烈建议为Prometheus提供持久磁盘。

*Sidecar模式组件少，占用的资源也相对较少，因此持久化存储+Sidecar模式是一个很好的选择*

从100w series数据结果也可以看出，receiver模式由于加载了remote-write模块，对应的内存和cpu占用比较多。而sidecar模式则不会有这些开销。

## Alertmaneger HA

由于Alermanager集群可以做到告警消息的去重(Gossip协议)，因此可以直接对接到多个Prometheus实例，这样就能使用原生的PrometheusRule进行告警规则管理。

Thanos提供了一个Ruler组件，用来实现与PrometheusRule相同的功能。因此对于这个集成，两种方案各有利弊：
- 使用PrometheusRule可以与目前现有的业务逻辑相匹配，不用改动太多，但是由于规则是作用在Prometheus本身，因此一般只具有2h的数据（也满足了告警实时要求），对于一些特殊的告警如需要查询多个区域或者很长时间范围的情况就不支持；
- Thanos Ruler可以统一管理各个Prometheus产生的数据并且对接到Alertmanger，缺点就是引入新的组件，维护成本增加


### Alermanager压力测试

#### 1w+ alerts
创建1w+ PrometheusRule，观察alertmanager资源使用情况：
| Time    | Pod                                                    | CPU Usage | CPU Limits | Memory Usage | Memory Limits |
|---------|--------------------------------------------------------|-----------|------------|--------------|---------------|
| 00:12.5 | alertmanager-prometheus-stack-kube-prom-alertmanager-1 | 0.02      | 1.2        | 67.41 MiB    | 1.05 GiB      |
| 00:12.5 | alertmanager-prometheus-stack-kube-prom-alertmanager-0 | 0.03      | 1.2        | 106.27 MiB   | 1.05 GiB      |
| 00:12.5 | prometheus-prometheus-stack-kube-prom-prometheus-0     | 0.36      | 2.2        | 1.94 GiB     | 20.05 GiB     |
| 00:12.5 | prometheus-prometheus-stack-kube-prom-prometheus-1     | 0.28      | 2.2        | 1.90 GiB     | 20.05 GiB     |



#### 3w+ alerts

| "Time"                  | "Pod"                                                  | "CPU Usage" | "CPU Limits" | "Memory Usage" | "Memory Limits" |
|-------------------------|--------------------------------------------------------|-------------|--------------|----------------|-----------------|
| 2023-09-08 17:08:14.251 | alertmanager-prometheus-stack-kube-prom-alertmanager-1 | 0.11        | 1.20         | 231.50 MiB     | 1.05 GiB        |
| 2023-09-08 17:08:14.251 | alertmanager-prometheus-stack-kube-prom-alertmanager-0 | 0.15        | 1.20         | 245.08 MiB     | 1.05 GiB        |
| 2023-09-08 17:08:14.251 | prometheus-prometheus-stack-kube-prom-prometheus-0     | 0.49        | 2.20         | 2.05 GiB       | 20.05 GiB       |
| 2023-09-08 17:08:14.251 | prometheus-prometheus-stack-kube-prom-prometheus-1     | 0.66        | 2.20         | 1.98 GiB       | 20.05 GiB       |

#### 10w+ alerts

| "Time"                  | "Pod"                                                  | "CPU Usage" | "CPU Limits" | "Memory Usage" | "Memory Limits" |
|-------------------------|--------------------------------------------------------|-------------|--------------|----------------|-----------------|
| 2023-09-08 17:50:30.813 | alertmanager-prometheus-stack-kube-prom-alertmanager-1 | 0.78        | 2.20         | 1021.53 MiB    | 5.05 GiB        |
| 2023-09-08 17:50:30.813 | alertmanager-prometheus-stack-kube-prom-alertmanager-0 | 1.26        | 2.20         | 1.15 GiB       | 5.05 GiB        |
| 2023-09-08 17:50:30.813 | prometheus-prometheus-stack-kube-prom-prometheus-0     | 1.97        | 2.20         | 3.64 GiB       | 20.05 GiB       |
| 2023-09-08 17:50:30.813 | prometheus-prometheus-stack-kube-prom-prometheus-1     | 1.86        | 2.20         | 3.49 GiB       | 20.05 GiB       |


*占用的cpu比较多*

#### 20w+ alerts

| "Time"                  | "Pod"                                                  | "CPU Usage" | "CPU Limits" | "Memory Usage" | "Memory Limits" |
|-------------------------|--------------------------------------------------------|-------------|--------------|----------------|-----------------|
| 2023-09-08 17:58:46.609 | alertmanager-prometheus-stack-kube-prom-alertmanager-1 | 1.63        | 2.20         | 1.68 GiB       | 5.05 GiB        |
| 2023-09-08 17:58:46.609 | alertmanager-prometheus-stack-kube-prom-alertmanager-0 | 1.67        | 2.20         | 1.68 GiB       | 5.05 GiB        |
| 2023-09-08 17:58:46.609 | prometheus-prometheus-stack-kube-prom-prometheus-0     | 2.00        | 2.20         | 4.19 GiB       | 20.05 GiB       |
| 2023-09-08 17:58:46.609 | prometheus-prometheus-stack-kube-prom-prometheus-1     | 2.00        | 2.20         | 4.43 GiB       | 20.05 GiB       |


*Prometheus的cpu已经打满了，故查询很慢*

## Minio

压测详情：[http://devops.docs.win/pages/55bb85](http://devops.docs.win/pages/55bb85)

## 参考文档

[http://39.105.137.222:8089/?p=2967](http://39.105.137.222:8089/?p=2967)

[https://mp.weixin.qq.com/s/U3-1bZUoim4zkB4RZbfNQg](https://mp.weixin.qq.com/s/U3-1bZUoim4zkB4RZbfNQg)

[https://mp.weixin.qq.com/s/DBJ0F3g2Y5EhS02D7k2n5w](https://mp.weixin.qq.com/s/DBJ0F3g2Y5EhS02D7k2n5w)

[https://yasongxu.gitbook.io/container-monitor/yi-.-kai-yuan-fang-an/di-2-zhang-prometheus/thanos](https://yasongxu.gitbook.io/container-monitor/yi-.-kai-yuan-fang-an/di-2-zhang-prometheus/thanos)

[https://thanos.io/tip/thanos/getting-started.md/#get-thanos](https://thanos.io/tip/thanos/getting-started.md/#get-thanos)

### 涉及到的脚本
生成svc脚本：
```bash
#!/bin/bash

filename="svcs.yaml"

cat <<EOF > $filename

EOF

for ((i=10001; i<=50000; i++))
do
    name="hxd-sd-$i"

    cat <<EOF >> $filename
---
apiVersion: v1
kind: Service
metadata:
  name: $name
  namespace: hxd-test
  labels:
    app: hxd-test-sd
spec:
  ports:
    - name: http
      protocol: TCP
      port: 80
      targetPort: 9001
  selector:
    app: avalanche
EOF

    echo "Added SVC: $name"
done

echo "Generated $filename"
```

生成servicemonitor脚本:
```bash
#!/bin/bash

filename="service-monitors.yaml"

cat <<EOF > $filename

EOF

for ((i=1; i<=1; i++))
do
    name="hxd-sd-$i"

    cat <<EOF >> $filename
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  labels:
    release: hxd-prometheus
  name: $name
  namespace: hxd-test
spec:
  endpoints:
    - path: /metrics
      port: http
  namespaceSelector:
    matchNames:
      - hxd-test
  selector:
    matchLabels:
      app: hxd-test-sd
EOF

    echo "Added ServiceMonitor: $name"
done

echo "Generated $filename"
```

avalanche部署，每个实例产生100w series：
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: avalanche
  namespace: hxd-test
  labels:
    app: avalanche
spec:
  replicas: 1
  selector:
    matchLabels:
      app: avalanche
  template:
    metadata:
      creationTimestamp: null
      labels:
        app: avalanche
    spec:
      containers:
        - name: avalanche
          image: hxd/avalanche:main
          args:
            - '--metric-count=10000'
            - '--label-count=1'
            - '--series-count=100'
            - '--value-interval=300000'
            - '--series-interval=300000'
            - '--metric-interval=300000'
          ports:
            - name: metrics
              containerPort: 9001
              protocol: TCP
```

磁盘相关命令：
```bash
docker run --rm -v "/home:/data/dist-test" bitnami/net-tools:v1.1 fio --rw=write --ioengine=sync --fdatasync=1 --directory=/data/dist-test --size=22m --bs=2300 --name=mytest

dd if=/dev/zero of=/home/random.dd bs=1M count=1024 oflag=direct iflag=nocache
```