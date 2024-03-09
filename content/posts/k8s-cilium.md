---
title: K8s之cilium网络插件预研
date: 2023-10-31
tags:
  - Kubernetes
  - Network
​---


## 名词术语

**eBPF (Extended Berkeley Packet Filter)**：是一种内核技术，它允许用户在内核中编写并注入自定义的代码片段，以扩展和改进网络和系统的功能。eBPF 最初是在 Linux 内核中引入的，但现在也在其他操作系统中得到支持。

**L2 - 数据链路层**：在物理地址（如 MAC 地址）上提供数据传输。例如，以太网、Wi-Fi 和 PPP（点对点协议）都在这一层工作。

**L3 - 网络层**：负责数据包的发送和路由，包括 IP 地址处理和路由器工作。例如，IP（互联网协议）就工作在这一层。

**L4 - 传输层**：负责端到端的消息传输和错误恢复。例如，TCP（传输控制协议）和 UDP（用户数据报协议）工作在这一层。

**L7 - 应用层**：为应用程序提供网络服务。例如，HTTP、FTP、SMTP 等协议工作在这一层。

**Label**：标签是定位大的资源集合的一种通用、灵活的方法。Cilium中很多地方使用标签和标签选择器实现。

**Endpoint**：通过为容器分配IP，Cilium让它在网络上可见。多个应容器可能具有相同IP，典型的例子是Pod中的容器。任何享有同一IP的容器，在Cilium的术语里面，叫做端点。

**Identity**：任何端点都被分配身份标识（Identity），身份标识通过端点的标签确定，并且具有集群范围内的标识符（数字ID）。端点被分配的身份标识，和它的安全相关标签匹配，也就是说，具有相同安全相关标签的所有端点，共享同一身份标识。

**XDP（eXpress Data Path）**：即快速数据路径，XDP是Linux网络处理流程中的一个eBPF钩子，能够挂载eBPF程序，它能够在网络数据包到达网卡驱动层时对其进行处理，具有非常优秀的数据面处理性能，打通了Linux网络处理的高速公路。



## 概述

**Cilium** 是一个开源软件，用于在 Kubernetes 集群中提供和管理网络连接和安全策略。它使用 eBPF (Extended Berkeley Packet Filter) 技术，eBPF完全在内核中运行，因此改变Cilium的安全策略时不需要程序代码、容器配置的任何变更，以用于创建安全、可扩展和高效的网络和监控解决方案。

**Hubble** 是一个基于 Cilium 和 eBPF 构建的开源网络观察工具，用于提供和可视化深度网络洞察。Hubble 可以观察、监视和理解 Kubernetes 集群中的网络流量。如：服务依赖和通信关系图、网络监控和报警、应用程序监控、安全可观察性。

### 架构

整体的架构图：

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/cilium-arch-1024x912.png)

#### Cilium

##### cilium-agent

cilium-agent在每个 Kubernetes 节点上运行，负责实现和管理网络策略和网络连接。管理所有eBPF程序，控制所有网络访问。

- **网络策略实施**：Cilium Agent 读取 Kubernetes 中定义的网络策略，然后使用 eBPF技术在内核级别实施这些策略。这些策略可以包括允许或阻止特定的网络连接，或者对网络流量进行限速等。

- **网络连接管理**：Cilium Agent 负责管理从 Pod 到其他 Pod、服务或外部网络的连接。这包括路由、负载均衡、NAT（网络地址转换）等。

- **服务发现**：Cilium Agent 可以与 Kubernetes API 服务器通信，自动发现新的服务和端点，并更新网络策略和连接。

- **IPAM**：Cilium Agent 包含一个 IP 地址管理（IPAM）模块，用于分配和回收 Pod IP 地址。

- **监控和故障排除**：Cilium Agent 提供丰富的监控和故障排除功能，包括流量跟踪、日志记录和性能指标。

Cilium Agent 的所有功能都是透明的，不需要更改应用程序的代码或容器的配置。这使得 Cilium 可以在任何支持 eBPF 的环境中运行，包括标准的 Linux 发行版、云服务和裸机服务器。

##### cilium-cli

cilium-cli(二进制文件叫cilium)和cilium-agent一起安装，它和cilium-agent的REST API交互，从而探测本地agent的状态。CLI也提供了直接访问eBPF map的工具。

##### cilium-operator

Cilium Operator 是 Cilium 网络项目的一个重要组件，它主要负责执行那些跨节点的、全局性的操作，以及一些长期运行的后台任务。Cilium Operator 的设计理念是将那些不需要在每个节点上都运行的任务抽取出来，这样可以减轻 Cilium Agent 的负担，提高整个系统的效率和可扩展性。

- **全局 IPAM 管理**：Cilium Operator 负责管理全局的 IP 地址池，为新的 Pods 分配 IP 地址，以及回收不再使用的 IP 地址。这个任务需要跨节点进行，因为 IP 地址是全局唯一的资源。

- **节点注册和注销**：当新的节点加入或离开集群时，Cilium Operator 会更新 Cilium 网络的配置，以确保网络连接和策略的正确性。

- **服务和端点的同步**：Cilium Operator 负责将 Kubernetes 的服务和端点信息同步到 Cilium 网络，以便 Cilium Agent 可以正确地路由和负载均衡网络流量。

- **垃圾回收**：Cilium Operator 还负责清理那些不再使用的资源，例如过期的 IP 地址、旧的连接状态等。这是一个长期运行的后台任务，可以在全局范围内进行。

目前（v1.14.3）包含的CRD：

- **CiliumCIDRGroups**：允许用户定义 IP 地址或 CIDR（无类别域间路由）的组，然后在网络策略中引用这些组。这样可以更方便地管理和控制网络流量。

- **CiliumClusterwideNetworkPolicies**：扩展了 Kubernetes 的网络策略，增加了一些新的选项和特性，例如更细粒度的流量控制、基于身份的访问控制等。这个 CRD 是集群范围的，适用于所有的命名空间。

- **CiliumEndpoints**：表示 Cilium 网络中的端点，包括 Pod、服务等。每个 CiliumEndpoint 对象都包含了端点的网络策略、状态、统计信息等。

- **CiliumExternalWorkloads**：将非 Kubernetes 工作负载（例如虚拟机或物理服务器）注册到 Cilium 网络，这样就可以用同样的网络策略和 IPAM 管理这些工作负载。

- **CiliumIdentities**：表示 Cilium 的安全身份，这是 Cilium 实现基于身份的访问控制的基础。

- **CiliumL2AnnouncementPolicies**：配置 Cilium 的二层网络公告策略，例如 ARP（地址解析协议）或 NDP（邻居发现协议）。

- **CiliumLoadBalancerIPPools**：管理 Cilium 的负载均衡 IP 地址池，这些 IP 地址用于服务的外部访问。

- **CiliumNetworkPolicies**：扩展了 Kubernetes 的网络策略，增加了一些新的选项和特性，例如更细粒度的流量控制、基于身份的访问控制等。

- **CiliumNodeConfigs**：配置 Cilium Agent 在特定节点上的行为，例如网络策略、路由、IPAM 策略等。

- **CiliumNodes**：表示 Cilium 网络中的节点，包括节点的 IP 地址、路由、状态等。

- **CiliumPodIPPools**：管理 Cilium 的 Pod IP 地址池，这些 IP 地址用于 Pod 的网络连接。

Cilium Operator 通常在 Kubernetes 集群中以单例或高可用模式运行，它与 Kubernetes API 服务器、Cilium Agent 以及其他 Kubernetes 组件紧密协作，共同维护 Cilium 网络的健康和性能。即使operator暂时不可用，集群仍然能正常运作一段时间，但是有可能会导致一些异常。


##### cilium-cni

和其他cni一样，实现了k8s的网络插件接口。cilium-cni和当前节点上的Cilium API交互，触发必要的datapath配置，以提供容器网络、LB、网络策略。


#### Hubble

##### hubble-server

Hubble 服务通常作为 Cilium Agent 的一部分运行在每个 Kubernetes 节点上，收集和处理该节点上的网络流量数据。可以通过 Cilium Agent 的 API 访问 Hubble 的数据和功能。


##### hubble-relay

hubble-relay是一个独立组件，能够连接到所有Server，通过Server的gRPC API，获取全集群的可观察性数据。这些数据又通过一个API来暴露出去。

##### hubble-ui

hubble提供了一个图形化的界面，用于展示和分析网络数据。

##### hubble-cli

hubble是一个命令行工具，能够连接到gRPC API、hubble-relay、本地server，来获取flow events。

#### 数据存储

Cilium需要一个数据存储，用来在Agent之间传播状态。

- K8S CRD：默认数据存储。
- KV Store：外部键值存储，可以提供更好的性能。支持etcd和consul。

### cilium带来的收益

#### 网络性能

**解决大规模集群iptable的瓶颈**：传统的Linux网络安全机制，例如iptables，基于IP地址、TCP/UDP端口进行过滤。在容器化架构下IP地址会很快变化，这会导致ACL规则、LB表需要不断的、加速（随着业务规模扩大）更新。由于IP地址不稳定，给实现精准可观察性也带来了挑战。

**网络策略增强**：拓展k8s原生网络策略能力，包括隔离、过滤、安全访问等功能。

**简单的容器网络**：Cilium支持一个简单的、扁平的L3网络，能够跨越多个集群，连接所有容器。通过使用host scope的IP分配器，IP分配被保持简单，每个主机可以独立进行分配分配，不需要相互协作。

**负载均衡**：Cilium实现了分布式的负载均衡，可以完全代替kube-proxy。LB基于eBPF实现，使用高效的、可无限扩容的哈希表来存储信息。对于南北向负载均衡，Cilium作了最大化性能的优化。支持XDP、DSR（Direct Server Return，LB仅仅修改转发封包的目标MAC地址）。

**带宽管理**：Cilium利用eBPF实现高效的基于EDT（Earliest Departure Time）的egress限速。

#### 网络监控和可视化

**网络流量可视化**：收集并可视化集群中的网络流量，帮助理解流量模式和行为。

**服务地图**：生成服务间通信的地图，帮助理解服务如何相互关联和互动。

**安全策略可视化**：显示安全策略如何影响网络流量，帮助理解和调整安全策略。

**性能指标**：收集和显示网络性能指标，如延迟、数据包丢失等，帮助监控和优化网络性能。

**故障排除**：通过提供详细的网络流量日志和历史数据，Hubble 可以帮助诊断和解决网络问题。

## 安装要求

Cilium 的安装要求:

| 要求                   |                           版本 | 是否在容器中 |
| :--------------------- | -----------------------------: | :----------: |
| Linux kernel           | >= 4.19.57 or >= 4.18 on RHel7 |      否      |
| Key-Value store (etcd) |                       >= 3.1.0 |      否      |
| clang+LLVM             |                        >= 10.0 |      是      |

**注：eBPF Host-Routing功能需要Linux kernel >= 5.10**

## 安装和配置

### Cilium 安装的步骤和方法

采用手动安装的方式：

```bash
# 安装cilium-cli
wget https://github.com/cilium/cilium-cli/releases/download/v0.15.0/cilium-linux-amd64.tar.gz
tar zvxfC /usr/bin/cilium-linux-amd64.tar.gz
# 安装cilium chart
helm repo add cilium https://helm.cilium.io
helm repo update
helm install cilium cilium/cilium  --namespace cilium  --kubeconfig config --create-namespace
# 升级
helm upgrade --install cilium charts/cilium/1.14.3   \
  --namespace cilium  \
  --kubeconfig config \
  --create-namespace  
```

检查安装：

```bash
cilium  status --wait --namespace cilium
cilium connectivity test -n cilium  --curl-image cilium/alpine-curl:v1.7.0 --json-mock-image cilium/json-mock:v1.3.5 --performance-image cilium/network-perf:a816f935930cb2b40ba43230643da4d5751a5711  --dns-test-server-image rancher/mirrored-coredns-coredns:1.9.0
```

### 网络策略、负载均衡和其他高级功能


#### IPAM

IPAM负责分配和管理网络端点（容器或其它）的IP地址。支持几种方法：

- kubernetes，使用Kubernetes自带的host-scope IPAM。**地址分配委托给每个节点进行**，Pod的CIDR存在每个v1.Node.Spec中

- cluster-pool，这是默认的IPAM mode，Cilium在 v2.CiliumNode中存储Pod的CIDR，并在**每个节点上使用host-scope的分配器来分配IP地址**。

- cilium Multi-Pool IPAM (Beta)，**使用Cilium的CiliumPodIPPool自定义资源给Pod分配IP**。



#### 网络策略

K8S标准的NetworkPolicy，可以用来指定L3/L4 ingress策略，以及受限的egress策略。CiliumNetworkPolicy同k8s自身的NetworkPolicy实现一样，默认全通，规则的生效是所见即所得，根据实际情况对规则进行Merge。Cilium网络策略支持L7层，扩展了原生策略的能力。

如：

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: example
spec:
  endpointSelector:  # 作用的对象集合
    matchLabels:
      a: b
  ingress:          # 入方向
  - fromEndpoints:  # 从哪里来
    - matchLabels:
        c: d
  ...
  egress:           # 出方向
  - toEndpoints:    # 到哪里去
    - matchLabels:
        e: f
  ...
```


##### L3策略

**基于端点标签**：示例说明**只允许**从标签为 `app=app1` 的端点通信到标签为 `app=nginx` 的终端点。

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: l3-rule-allow-app1-to-nginx
spec:
  endpointSelector:
    matchLabels:
      app: nginx
  ingress:
  - fromEndpoints:
    - matchLabels:
        app: app1
```

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/p1.png)

**基于svc（理解上有点问题）**：示例说明**允许**所有标签为`app=app1`的终端点与kubernetes命名空间`default`下的服务`nginx`的所有端点通信。

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: l3-rule-allow-app1-to-nginx-svc
spec:
  endpointSelector:
    matchLabels:
      app: app1
  egress:
  - toServices:
    - k8sService:
        serviceName: nginx
        namespace: default
```

预期：app1通nginx，实际：居然是app1不通，app2通

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/p2.png)


**基于实体身份标识**：示例说明**允许**`app=app1`的端点到本地主机的所有通信，到其他的主机则拒绝。

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: "app1-to-host"
spec:
  endpointSelector:
    matchLabels:
      app: app1
  egress:
    - toEntities:
      - host
```

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/p3.png)

除了host，还包括一些内置的实体身份：remote-node、kube-apiserver、ingress等等。


除了以上几种，还有基于 DNS，IP/CIDR等方式。

##### L4策略

限制端口上TCP连接：

```yaml
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: "l4-rule"
spec:
  endpointSelector:
    matchLabels:
      app: app1
  egress:
    - toPorts:
      - ports:
        - port: "80"
          protocol: TCP
```

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/p4.png)

##### L7策略

**基于HTTP（包括gRPC）**

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/nginx-rules.png)

除此之外，还支持Kafka（beta）。

#### 负载均衡

我们启用了替换kube-proxy功能，因此节点上可以完全去掉kube-proxy组件，并且可以在cilium观察服务：

```bash
root@master01:/home/cilium# cilium service list
ID   Frontend                Service Type   Backend
3    10.43.0.1:443           ClusterIP      1 => 192.168.101.181:6443 (active)
4    10.43.78.28:80          ClusterIP      1 => 10.42.0.142:8080 (active)
5    10.43.95.36:443         ClusterIP      1 => 10.42.1.148:8443 (active)
                                            2 => 10.42.0.248:8443 (active)
6    10.43.0.10:53           ClusterIP      1 => 10.42.1.81:53 (active)
                                            2 => 10.42.0.165:53 (active)
7    10.43.0.10:9153         ClusterIP      1 => 10.42.1.81:9153 (active)
                                            2 => 10.42.0.165:9153 (active)
8    10.43.166.103:443       ClusterIP      1 => 10.42.0.123:4443 (active)
```

#### 集群网络

Cluster Mesh将网络数据路径延伸到多个集群，支持以下特性：

- 实现所有集群的Pod之间相互连通，不管使用直接路由还是隧道模式。不需要额外的网关节点或代理
- 支持全局服务，可以在所有集群访问，支持跨集群的服务发现和负载均衡
- 支持全局性的安全策略，跨集群网络策略
- 支持跨集群边界通信的透明加密
- 集群外工作负载，可以将外部工作负载（例如VM）加入到K8S集群，并且应用安全策略

应用场景：

- 高可用
  两个（位于不同Region或AZ的）集群组成高可用，当一个集群的后端服务（不是整个AZ不可用）出现故障时，可以failover到另外一个集群的对等物。

- 共享服务
  最初的K8S用法是，倾向于创建巨大的、多租户的集群。而现在，更场景的用法是为每个租户创建独立的集群，甚至为不同类型的服务（例如安全级别不同）创建独立的集群。尽管如此，仍然有一些服务具有共享特征，不适合在每个集群中都部署一份。这类服务包括：日志、监控、DNS、密钥管理，等等。

使用集群网格，可以将共享服务独立部署在一个集群中，租户集群可以访问其中的全局服务。


#### NodePort XDP加速

对于LoadBalancer/NodePort/其它具有ExternalIP的服务，如果外部流量入群节点上没有服务后端，则入群节点需要将请求转发给其它节点。

开启方法：

```
helm install cilium ./cilium \
    --namespace cilium \
    --set routingMode=native \
    --set kubeProxyReplacement=true \
    --set loadBalancer.acceleration=native \
    --set loadBalancer.mode=hybrid \
    --set k8sServiceHost=${API_SERVER_IP} \
    --set k8sServicePort=${API_SERVER_PORT}
```

检查是否生效：

```bash
cilium status --verbose 
KubeProxyReplacement Details:
  ...
  XDP Acceleration:       Native  # 表示已开启XDP
  ...
```

测试结果：

| flow              | sender         | receiver       |
| :---------------- | :------------- | :------------- |
| k8s节点之间(基准) | 11.5 Gbits/sec | 11.5 Gbits/sec |

kube-ovn:

| flow                                 | sender         | receiver       |
| :----------------------------------- | :------------- | :------------- |
| pod到Service，同节点                 | 15.1 Gbits/sec | 15.1 Gbits/sec |
| pod到Service，不同节点               | 1.29 Gbits/sec | 1.28 Gbits/sec |
| 外部节点到Service-nodeport，同节点   | 9.76 Gbits/sec | 9.71 Gbits/sec |
| 外部节点到Service-nodeport，不同节点 | 1.06 Gbits/sec | 1.05 Gbits/sec |

cilium XDP:

| flow                                 | sender         | receiver       |
| :----------------------------------- | :------------- | :------------- |
| pod到Service，同节点                 | 28.4 Gbits/sec | 28.3 Gbits/sec |
| pod到Service，不同节点               | 11.0 Gbits/sec | 10.9 Gbits/sec |
| 外部节点到Service-nodeport，同节点   | 9.88 Gbits/sec | 9.84 Gbits/sec |
| 外部节点到Service-nodeport，不同节点 | 8.23 Gbits/sec | 8.19 Gbits/sec |

从结果上看，cilium XDP相比kube-ovn在各方面都要强，而且对于跨界点的性能上也比较接近虚拟层的性能。

限制：内核版本需要大于等于5.2，需要网卡支持本地XDP的驱动程序。

#### 带宽限速

利用Cilium的带宽管理器，可以有效的在EDT（Earliest Departure Time）、eBPF的帮助下，管理每个Pod的带宽占用。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qperf
  namespace: default
  labels:
    app: qperf
spec:
  replicas: 4
  selector:
    matchLabels:
      app: qperf
  template:
    metadata:
      creationTimestamp: null
      labels:
        app: qperf
      annotations:
        kubernetes.io/egress-bandwidth: 10M # 使用方法
    spec:
      containers:
        - name: qperf
          image: hxd/qperf
```

结果：

```bash
/ # qperf -t 60  10.42.1.69 -ub -oo msg_size:4K -vu tcp_bw
tcp_bw:
    bw        =  9.6 Mb/sec
    msg_size  =    4 KiB (4,096)
    time      =   60 sec
```

#### BGP

IPv6 BIG TCP，Kernel >= 5.19

IPv4 BIG TCP，Kernel >= 6.3

与IPv6 BIG TCP类似，IPv4 BIG TCP允许网络堆栈准备更大的GSO（传输）和GRO（接收）数据包，以减少堆栈遍历的次数，从而提高性能和延迟。减少了CPU负载，并帮助实现更高的速度（即100Gbit/s及以上）。

此外还有一些新特性：BBR Pods 拥塞控制、巨型帧MTU......

## RKE 支持

RKE目前不支持选择安装 Cilium 网络插件。支持的话需要修改rke代码。

可以将网络设置为none，然后使用helm安装。

```yaml
network:
  plugin: none
```

此外，如果需要启用替换kube-proxy，需要在rke安装时，跳过部署kube-proxy（有可能导致部署失败），或者手动docker stop kube-proxy。


## CNI 对比

Cilium 与其他常见的 Kubernetes 网络插件进行对比，总体矩阵：

| 项目/插件      | Flannel   | Calico          | Cilium                | Canal     | Kube-OVN             |
| :------------- | :-------- | :-------------- | :-------------------- | :-------- | :------------------- |
| 部署模式       | DaemonSet | DaemonSet       | DaemonSet             | DaemonSet | DaemonSet,Deployment |
| 封装和路由     | VxLAN     | IPinIP,BGP,eBPF | BGP,VxLAN,eBPF,geneve | VxLAN     | VxLAN,geneve,OVS     |
| 网络策略支持   | No        | Yes             | Yes                   | Yes       | Yes                  |
| 使用的数据存储 | etcd      | etcd            | etcd                  | etcd      | OVN,etcd             |
| 加密           | Yes       | Yes             | Yes                   | Yes       | Yes                  |
| 集群互联       | No        | Yes             | Yes                   | No        | Yes                  |
| 带宽管理       | No        | No              | Yes                   | No        | Yes                  |
| Github Starts  | 8.3k      | 5.1k            | 16.9k                 | 500       | 1.7k                 |


### 粗略测试结果

环境信息：

| 节点     | cpu     | 内存   | ISO                                | 内核版本 |
| :------- | :------ | :----- | :--------------------------------- | :------- |
| master01 | 8 vCore | 16 Gib | xxx-xxx-V9.3.0-x86_64-20230926.iso | 5.10.0   |
| worker01 | 8 vCore | 16 Gib | xxx-xx-V9.3.0-x86_64-20230926.iso  | 5.10.0   |


使用以下命令进行测试：
`qperf -t 60 server-ip -ub -oo msg_size:4K -vu tcp_lat tcp_bw udp_lat udp_bw`

结果：

| Flow         | tcp_lat | udp_lat | tcp_bw      | udp_send_bw | udp_recv_bw |
| :----------- | :------ | :------ | :---------- | :---------- | :---------- |
| node-to-node | 66.9 us | 101 us  | 11.9 Gb/sec | 2.62 Gb/sec | 2.6 Gb/sec  |

kube-ovn(geneve overlay)：

| Flow                       | tcp_lat | udp_lat | tcp_bw      | udp_send_bw | udp_recv_bw |
| :------------------------- | :------ | :------ | :---------- | :---------- | :---------- |
| pod-to-pod(同集群同节点)   | 28.5 us | 31.2 us | 2.64 Gb/sec | 1.83 Gb/sec | 1.81 Gb/sec |
| pod-to-pod(同集群不同节点) | 108 us  | 102 us  | 1.76 Gb/sec | 1.72 Gb/sec | 1.65 Gb/sec |

cilium(Default vxlan overlay):

| Flow                       | tcp_lat | udp_lat | tcp_bw      | udp_send_bw | udp_recv_bw |
| :------------------------- | :------ | :------ | :---------- | :---------- | :---------- |
| pod-to-pod(同集群同节点)   | 25.5 us | 29.2 us | 2.68 Gb/sec | 1.79 Gb/sec | 1.79 Gb/sec |
| pod-to-pod(同集群不同节点) | 94.8 us | 91.7 us | 1.97 Gb/sec | 1.7 Gb/sec  | 1.68 Gb/sec |


cilium(eBPF Host-Routing):

| Flow                       | tcp_lat     | udp_lat   | tcp_bw          | udp_send_bw     | udp_recv_bw     |
| :------------------------- | :---------- | :-------- | :-------------- | :-------------- | :-------------- |
| pod-to-pod(同集群同节点)   | 25 us       | 42 us     | 3.03 Gb/sec     | 2.14 Gb/sec     | 2.13 Gb/sec     |
| pod-to-pod(同集群不同节点) | **75.8 us** | **97 us** | **11.2 Gb/sec** | **2.46 Gb/sec** | **2.45 Gb/sec** |


## 友商解决方案

**私有云**：

Rancher、K3s：默认使用Flannel网络，也可以安装Calico等第三方网络插件。未集成网络流量可视化。

kubesphere：优先Calico 和 Flannel。其他插件也适用（例如 Cilium 和 Kube-OVN 等），但未经充分测试。未集成网络流量可视化。

博云：Fabric（OVS自研），Calico。从官方用户手册以及用户文档都没有涉及到cilium，门户上也没有cilium相关的功能。

浪潮云海容器云：支持包含Flannel、Calico、Weave等多种Kubernetes网络插件。

Daocloud：Calico、Cilium、Multus-underlay、Aliyun CNI，未集成网络流量可视化。

**公有云**：

青云QKE：Hostnic（自研），Flannel、Calico。

阿里云ACK：Terway（自研），Flannel。

腾讯云TKE：GlobalRouter、VPC-CNI 和 Cilium-Overlay均为自研定制。

华为云：Canal、Yangtse均为自研定制。

天翼云：Cilium（数据来自罗云）。

深信服：Cilium（数据来自罗云）。


## 性能和可观测性

Cilium自带了Prometheus指标，因此只需要开启监控功能即可采集观察丰富的网络指标。

![](https://hindung.oss-cn-beijing.aliyuncs.com/img/metrics.png)

## 社区支持和文档

到目前为止，Cilium 的社区活跃度非常高，Github Stars 16.9k。GitHub 仓库有大量的贡献者和活跃的提交，还有大量的开放和已解决的问题。此外，Cilium 还有一个活跃的 Slack 频道，用户可以在那里提问和交流。Cilium 也有定期的社区会议，讨论项目的发展和未来的计划。从这些角度看，Cilium 的社区支持水平非常高。

Cilium 的官方文档非常详细，涵盖了安装、配置、使用和扩展 Cilium 的各个方面。文档中还包含了大量的示例和教程，可以帮助用户理解和使用 Cilium。

## 虚拟化支持

对于k8s+kubevirt+cilium的场景，cilium除了给pod/vm提供网络功能外，还支持XDP等功能。

virtio_net开启XDP依赖的内核版本 >= 4.10，并且可能需要开启multiqueue模式，在virtio类型的虚拟机上部署，正常启动XDP：

```bash
# ethtool -i eth0
driver: virtio_net
...
# cilium status
...
KubeProxyReplacement:    True   [eth0 192.168.242.27 (Direct Routing)]
...
KubeProxyReplacement Details:
  Status:                 True
  XDP Acceleration:       Native
...
```

[https://github.com/xdp-project/xdp-tutorial/issues/277](https://github.com/xdp-project/xdp-tutorial/issues/277)

[https://kubevirt.io/user-guide/virtual_machines/interfaces_and_networks/#virtio-net-multiqueue](https://kubevirt.io/user-guide/virtual_machines/interfaces_and_networks/#virtio-net-multiqueue)


## 总结和结论


**优点**：

1. **基于 BPF 的性能优化**：Cilium 使用 eBPF（扩展的伯克利包过滤器）技术，可以在内核级别提供高效的数据包处理和路由能力，从而提高性能。

2. **基于身份的安全策略**：Cilium 不仅支持基于 IP 地址的网络策略，还支持基于 Pod 或服务身份的网络策略，这可以提供更细粒度和更灵活的访问控制。

3. **网络可视化**：Cilium 的子项目 Hubble 提供了丰富的网络可视化和监控功能，可以帮助理解和排查网络问题。

4. **多协议支持**：Cilium 支持多种网络协议，包括 IPv4、IPv6、TCP、UDP 和 HTTP，可以满足不同的网络需求。

5. **集成和扩展性**：Cilium 可以与 Kubernetes、Istio、Envoy 等项目集成，提供更完善的网络和服务网格功能。Cilium 还支持自定义资源定义（CRD），可以扩展 Kubernetes 的 API。

**限制**：

1. **学习曲线**：Cilium 使用了一些高级的网络和安全技术，如 eBPF、CRD 等，对于新手来说可能有一定的学习曲线。

2. **依赖 Linux 内核版本**：Cilium 的一些功能依赖于特定版本的 Linux 内核，如果内核版本过低，可能无法使用这些功能。


**适用场景**：

1. **Kubernetes 网络**：Cilium 可以作为 Kubernetes 的 CNI 插件，提供 Pod 网络和服务网络。

2. **服务网格**：Cilium 可以与 Istio、Envoy 等服务网格项目集成，提供更高级的服务网络功能。

3. **网络安全**：Cilium 提供了基于身份的网络策略和访问控制，可以用于保护 Kubernetes 集群的网络安全。

4. **网络监控和排查**：Cilium 的 Hubble 可以提供丰富的网络可视化和监控功能，帮助理解和排查网络问题。


总的来说，Cilium 是一个非常值得考虑的选项，特别是对于需要高性能、高安全性和高可视化的 Kubernetes 环境。而且在社区也有很多采用cilium的厂商，是主流的方向。

## 参考链接

https://github.com/cilium/cilium

https://docs.cilium.io/en/latest/overview/component-overview/

https://docs.cilium.io/en/latest/operations/system_requirements/#admin-system-reqs

https://blog.gmem.cc/cilium

https://rke.docs.rancher.com/config-options/add-ons/network-plugins

https://doc.crds.dev/github.com/cilium/cilium@1.14.3


## 问题

### 部署

- **nsenter: cannot open /hostproc/1/ns/cgroup**: No such file or directory 内核版本不符合要求，升级到符合的版本

- **CiliumNode: error: allocator not configured for the requested cidr 10.0.1.0/24** 由于安装时已指定cluster-cidr为10.42.0.0/16，但是在第一安装cilium时，默认的配置是：clusterPoolIPv4PodCIDRList: ["10.0.0.0/8"]，卸载cilium也不会删除掉已经安装的CRD和CR资源，因此重新安装也会有这个报错。卸载时把CRD全部清理解决。


11/29号会议纪要：

1、对于Wingarden目前的规模来说，可以按较低优先级支持cilium组件

2、关注与Wingarden应用的场景，如网络抖动、丢包预警等，可视化可以参考Tetrate skywalking 

3、对于eBPF的安全性需要进一步了解与研究

4、罗云要求研究cilium，是因为他去参加容器相关标准的会议时，听到有要求支持先进的网络组件，我们的系统做出来不希望是用的落后的网络组件

