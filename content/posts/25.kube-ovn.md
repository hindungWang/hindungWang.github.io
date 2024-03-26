---
title: K8s之kube-ovn网络插件
date: 2023-04-27
description: kube-ovn研究
tags:
  - Kubernetes
  - Network
---
# kube-ovn网络

此项预研包括了多网卡、集群互联、混合部署、OVS/OVN、CNI、kubevirt等基础组件，并探讨基于K8s实现的OVN平台所实现的功能以及能否满足公司不同场景的容器、虚拟机网络需求。

## kube-ovn

Kube-OVN是一个基于Open Virtual Network (OVN)的Kubernetes网络解决方案。它使用OVN作为底层网络虚拟化平台，为Kubernetes集群提供高性能、高可用、可扩展的网络服务。

下面是Kube-OVN的整体架构：

1. OVN控制平面（与传统OVN类似）

负责管理Kubernetes集群的网络资源和配置，包括虚拟网络（VPC）、子网（Subnet）、路由、ACL等。**这些组件部分来自 OVN/OVS 社区，Kube-OVN 对不同的使用场景做了特定修改。**

OVN控制平面由多个组件组成，包括：

- ovn-central：运行 OVN 的管理平面组件，负责处理逻辑网络拓扑，包括虚拟网络、子网、路由等。包括ovn-nb, ovn-sb,和ovn-northd。
- ovn-controller: 执行所有Kubernetes内资源到OVN资源的翻译工作。
- ovs-ovn：运行了 openvswitch, ovsdb,和ovn-controller。这些组件作为 ovn-central 的 Agent 将逻辑流表翻译成真实的网络配置。

2. OVN数据平面（由内核提供）

负责实现虚拟网络的转发和隔离。OVN数据平面利用Linux内核提供的虚拟化技术，如Linux内核自带的Open vSwitch (OVS)和Virtual Extensible LAN (VXLAN)，实现高性能、高可扩展性的虚拟网络。

3. Kubernetes控制平面（结合k8s资源）

负责管理Kubernetes集群的各种资源，如Pod、Service、Endpoint、CR等，并将这些资源转换（翻译）为对应的OVN网络配置，以实现Kubernetes网络服务。

除此之外，Kube-OVN还提供了一些额外的组件和工具：
- kube-ovn-cni：实现 CNI 接口，并操作本地的 OVS 配置单机网络。
- kube-ovn-operator：用于简化Kube-OVN的安装、配置和管理。 
- kube-ovn-monitor：监控指标。
- kube-ovn-pinger：收集 OVS 运行信息，节点网络质量，网络延迟等信息。
- kubectl-ko：OVN 运维平面用到的命令行工具。
- kube-ovn-speaker：对外发布容器网络的路由，使得外部可以直接通过 Pod IP 访问容器。

### kube-ovn部署使用

kube-ovn有两种方式部署Overlay和Underlay模式。

默认是Overlay模式。

Underlay：容器运行在虚拟机中，ovs运行在k8s上（POD部署），kube-ovn将容器网络和虚拟机网络连接在同一平面，**可以直接给容器分配物理网络中的地址资源**，达到更好的性能以及和物理网络的连通性。

Overlay：容器运行在虚拟机中，ovs运行在k8s上（POD部署），kube-ovn的默认子网**使用 Geneve 对跨主机流量进行封装**，在基础设施之上抽象出一层虚拟的 Overlay 网络。对于容器IP直通的场景可以配合multus-cni为容器添加额外的虚拟机层IP。或者参考高级功能采用路由或者BGP方式将容器网络和物理网络打通。


Underlay模式下能够获得更好网络性能，但是无法使用Overlay模式下的SNAT/EIP，分布式网关/集中式网关等 L3 功能，VPC 级别的隔离也无法对 Underlay 子网生效。


安装完成kube-ovn之后会自动创建一些组件以及CRDs：

**Deployment：**
- kube-ovn-controller
- ovn-central
- kube-ovn-monitor

**DaemonSet：**
- kube-ovn
- kube-ovn-cni
- kube-ovn-pinger

**CRDs:**
- Vpc：多租户隔离级别的 VPC 网络。不同 VPC 网络相互独立。（VPC 无法对 Underlay 子网进行隔离）
- VpcNatGateway：VPC 网络与外部通讯的网关。Overlay 子网下的 Pod 需要通过网关来访问集群外部网络
- VpcDns：VPC 内 Pod 无法使用默认的 coredns 服务进行域名解析。可以定义 VPC 内的 DNS。
- Vlan：Underlay 使用 Vlan 模式部署。
- Vip：虚拟IP。
- SwitchLBRule：VPC 的使用场景下，自定义内部负载均衡的地址范围（Service的增强）。
- Subnet：子网。
- SecurityGroup：安全组。
- ProviderNetwork：Underlay 模式下的网卡网络管理。
- OvnSnatRule：官网未提及。
- OvnFip：官网未提及。
- OvnEip：官网未提及。
- IptablesSnatRule：配置SNAT规则，一组 Pod 可以共享一个 IP 地址对外进行访问。
- IptablesFIPRule：配置浮动IP。
- IptablesEIP：配置外部访问IP，一个 Pod 可以直接和一个外部 IP 关联， 外部服务可以通过 EIP 直接访问 Pod，Pod 也将通过这个 EIP 访问外部服务。
- IptablesDnatRule：配置DNAT规则。
- IP：已分配的 IP 地址列表。

#### 功能使用

一些功能看起来比较复杂，但实际使用还是比较简单的，在对应的资源上打 Annotation 就可以了。此外即使不做任何配置，Kube-OVN 会带一个默认的子网，默认的分布式网关，以及内置的 Service 和 NetworkPolicy 实现。

比如给POD固定地址：
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: static-ip
  annotations:
    ovn.kubernetes.io/ip_address: 10.16.0.15
    ovn.kubernetes.io/mac_address: 00:00:00:53:6B:B6
spec:
  containers:
  - name: static-ip
    image: nginx:alpine
```
或者IP池：
```yaml
ovn.kubernetes.io/ip_pool: 10.16.0.15,10.16.0.16,10.16.0.17
```

kube-ovn针对kubevirt虚拟机有做特定的处理，能让kubevirt虚拟机实例在生命周期内启停，升级，迁移等操作过程中地址固定不变。

除此之外，还提供容器网络QoS设置、流量镜像等功能。

创建VPC、Subnet等：
```yaml
kind: Vpc
apiVersion: kubeovn.io/v1
metadata:
  name: test-vpc-1
spec:
  namespaces:
  - ns1
---
kind: Subnet
apiVersion: kubeovn.io/v1
metadata:
  name: net1
spec:
  vpc: test-vpc-1
  cidrBlock: 10.0.1.0/24
  protocol: IPv4
  namespaces:
    - ns1
```

### kube-ovn架构及技术分析

kube-ovn通过监听自定义资源CR的创建，将这些配置翻译成网络配置并设置，主要是调用以下ovn命令行工具配置ovs：
```go
// pkg/ovs/ovn.go
const (
	OvnNbCtl    = "ovn-nbctl"
	OvnSbCtl    = "ovn-sbctl"
	OVNIcNbCtl  = "ovn-ic-nbctl"
	OVNIcSbCtl  = "ovn-ic-sbctl"
	OvsVsCtl    = "ovs-vsctl"
	MayExist    = "--may-exist"
	IfExists    = "--if-exists"
	Policy      = "--policy"
	PolicyDstIP = "dst-ip"
	PolicySrcIP = "src-ip"

	OVSDBWaitTimeout = 0
)
```

整体架构如图所示：

![1](https://hindung.oss-cn-beijing.aliyuncs.com/img/kube-ovn.jpg)

相对于k8s网络要求来说，ovn的能力已经超出了这个范围。即在软件交换机层面实现网络打通，而且提供了更丰富的网络功能。

为了方便理解，可以做以下对比：

ovs：单机软件，没有集群的概念，就好比docker或者其他容器运行时。

ovn：相当于ovs的k8s，一个集中式的OVS控制面。从集群角度编排网络设施。

当给一个pod分配ip地址的同时，ovn会更新对应的逻辑交换机端口：
```bash
# 容器内
/ # ip a
56: eth0@if57: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1400 qdisc noqueue state UP
    link/ether 00:00:00:c4:e5:f9 brd ff:ff:ff:ff:ff:ff
    inet 10.16.0.5/16 brd 10.16.255.255 scope global eth0
       valid_lft forever preferred_lft forever
    inet6 fe80::200:ff:fec4:e5f9/64 scope link
       valid_lft forever preferred_lft forever
/ # route -n
Kernel IP routing table
Destination     Gateway         Genmask         Flags Metric Ref    Use Iface
0.0.0.0         10.16.0.1       0.0.0.0         UG    0      0        0 eth0
10.16.0.0       0.0.0.0         255.255.0.0     U     0      0        0 eth0
# 节点上与之对应的虚拟网卡
[root@vm25 ~]# ip a
57: f254898cfaf5_h@if56: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1400 qdisc noqueue master ovs-system state UP group default qlen 1000
    link/ether 62:ca:ab:20:7d:7b brd ff:ff:ff:ff:ff:ff link-netnsid 3
    inet6 fe80::60ca:abff:fe20:7d7b/64 scope link 
       valid_lft forever preferred_lft forever
# 节点上的ovs网桥连接状态
[root@vm24 ~]# kubectl ko vsctl vm25 show
a0c00567-d1e1-4be8-b131-9e5dd1f014f8
    Bridge br-int
        fail_mode: secure
        datapath_type: system
        Port f254898cfaf5_h
            Interface f254898cfaf5_h
        ...
    ovs_version: "2.17.7"

# 查看ovs北向连接状态
[root@vm24 ~]# kubectl ko nbctl show
switch cf603059-294b-4147-a3b4-98ddb45cb051 (ovn-default) # 虚拟交换机信息
    port static-mul-vm-ip.default   # 连接到容器的端口
        addresses: ["00:00:00:C4:E5:F9 10.16.0.5"]
    ...
switch 626913df-9994-42ad-96e3-330a8fec1f08 (join)
    port node-vm25
        addresses: ["00:00:00:72:50:54 100.64.0.3"]
    port node-vm24
        addresses: ["00:00:00:49:34:29 100.64.0.2"]
    port node-vm26
        addresses: ["00:00:00:0A:39:76 100.64.0.4"]
    port join-ovn-cluster
        type: router
        router-port: ovn-cluster-join
router e0926da7-aca3-4c41-821d-3bc5305ebf1c (ovn-cluster) # 路由信息
    port ovn-cluster-join
        mac: "00:00:00:42:79:A9"
        networks: ["100.64.0.1/16"]
    port ovn-cluster-ovn-default
        mac: "00:00:00:BE:79:30"
        networks: ["10.16.0.1/16"]  # 容器所指向的网关
```

## 多网卡方案

目前主流的多网卡方案都是采用[multus-cni](https://github.com/k8snetworkplumbingwg/multus-cni)来实现多网卡功能，multus-cni是英特尔公司开源的多网卡的解决方案。

### 部署

multus-cni允许POD通过不同的接口连接到多个网络，并且每个接口都将使用其自己的CNI插件。

构建高性能网络可以采用sr-iov、dpdk的方案。但这需要硬件网卡的支持。我们用multus和macvlan的方案实现pod多网卡的功能。

macvlan是linux内核实现的功能，它可以实现虚拟化多个物理网络接口（NIC）并为每个虚拟接口分配一个唯一的MAC地址。

开启macvlan需要内核编译并加载模块，可以使用以下方法：

```bash
# 查看内核是否加载了 macvlan 模块
lsmod | grep macvlan 
# 加载 macvlan
modprobe macvlan
```

其余操作按照官网部署即可：https://github.com/k8snetworkplumbingwg/multus-cni/blob/master/docs/quickstart.md

### 功能使用

首先创建一个NetworkAttachmentDefinition CR 用于配置POD的网卡。

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: macvlaneip
  namespace: default
spec:
  config: >-
    {
      "cniVersion": "0.3.0",
      "type": "macvlan",
      "master": "eth0",
      "mode": "bridge",
      "ipam": {
        "type": "kube-ovn",
        "server_socket": "/run/openvswitch/kube-ovn-daemon.sock",
        "provider": "macvlaneip.default"
      }
    }
```

这里直接对接的是kube-ovn插件。

type表示所使用的多网卡的方案类型，macvlan、sriov。
master是macvlan类型特有的配置，有5种模式。

provider表示当前 NetworkAttachmentDefinition 的 `<name>.<namespace>` , Kube-OVN 将会使用这些信息找到对应的 Subnet 资源。并从Subnet里分配IP。

创建对应的Subnet和POD：

```yaml
apiVersion: kubeovn.io/v1
kind: Subnet
metadata:
  name: macvlaneip
spec:
  cidrBlock: 192.168.101.0/24
  excludeIps:
    - 192.168.101.1..192.168.101.56
    - 192.168.101.59..192.168.101.255
  gateway: 192.168.101.1
  protocol: IPv4
  provider: macvlaneip.default # 与上面的provider一致
---
apiVersion: v1
kind: Pod
metadata:
  name: static-mul-eip
  namespace: default
  annotations:
    k8s.v1.cni.cncf.io/networks: macvlaneip@nic1
spec:
  containers:
    - name: static-ip
      image: nginx:alpine
```

从容器中可以看到 nic1 是我们添加的网卡：
```bash
 # ip addr
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
2: tunl0@NONE: <NOARP> mtu 1480 qdisc noop state DOWN qlen 1000
    link/ipip 0.0.0.0 brd 0.0.0.0
3: nic1@tunl0: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1500 qdisc noqueue state UP
    link/ether aa:1c:38:5f:82:be brd ff:ff:ff:ff:ff:ff
    inet 192.168.101.57/24 brd 192.168.101.255 scope global nic1
       valid_lft forever preferred_lft forever
208: eth0@if209: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1400 qdisc noqueue state UP
    link/ether 00:00:00:af:ee:fd brd ff:ff:ff:ff:ff:ff
    inet 10.16.0.127/16 brd 10.16.255.255 scope global eth0
       valid_lft forever preferred_lft forever
```


### 原理介绍

multus实现的原理如图所示：

![1](https://hindung.oss-cn-beijing.aliyuncs.com/img/multus.jpg)

当创建pod时，Kubelet 会调用其容器运行时（如 Docker 或 containerd）设置 pod。Kubelet 还为容器运行时提供一个网络插件包装程序，用于配置其网络。此处指 Multus CNI 插件。Multus 可与配置文件一起使用，支持使用网络对象或二者的组合。在所有这些模式中，Multus 读取配置，将设置网络的实际任务转移至其他被称为代理 (delegate) 的 CNI 插件。

Multus 然后为每个代理（CNI 插件及其相应配置）调用 delegateAdd()。然后，它们调用自己的 confAdd()函数，以添加 Pod 的网络接口。这些代理定义需调用的 CNI 插件和它们的参数。这些 CNI 插件的参数可作为 CRD 对象存储在 Kubernetes 中。

Multus 利用 pod 注释中的网络信息创建更多网络。通过获取 pod 注释，Multus 将确定应调用其他哪些 CNI 插件。


## Kubevirt

结合 Kube-OVN（Overlay模式） 和 Kubevirt，通过控制网络所属的 VPC 和 Subnet 来实现不同的 VM 落在不同的租户网络，从而实现整个虚拟化方案的多租户。

而且 Kube-OVN（Overlay模式） 还提供了租户内的 LB/EIP/NAT/Route Table 等功能，能够像控制传统虚拟化网络一样来控制云原生虚拟化下的网络。


### VM网络

kubevirt 启动时，会首先启动启动virt-launcher Pod，通过virt-launcher配置虚拟机的网络。virt-launcher Pod中会启动compute容器用与执行qemu和libvirt进程。整个网络装载过程如图：

![1](https://hindung.oss-cn-beijing.aliyuncs.com/img/kubevirt-network.jpg)

首先由kube-ovn-cni为virt-launcher POD通过veth pair（类似于管道通向两端）的方式将kube-ovn ovs 网桥 xxx_h 与容器中的 eth0 连接起来。

然后kubevirt会将virt-launcher POD eth0网卡创建网桥k6t-eth0和tap0设备，tap0设备用于连接到VM中的eth0。

**虚拟机层面**
```bash
$ ip a
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue qlen 1
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host 
       valid_lft forever preferred_lft forever
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1400 qdisc pfifo_fast qlen 1000
    link/ether 52:54:00:1f:04:35 brd ff:ff:ff:ff:ff:ff
    inet 10.0.2.2/24 brd 10.0.2.255 scope global eth0
       valid_lft forever preferred_lft forever
    inet6 fe80::5054:ff:fe1f:435/64 scope link 
       valid_lft forever preferred_lft forever
$ ip route
default via 10.0.2.1 dev eth0 
10.0.2.0/24 dev eth0  src 10.0.2.2 
```

**POD 层面**
```bash
bash-5.1$ ip route
default via 10.16.0.1 dev eth0
10.0.2.0/24 dev k6t-eth0 proto kernel scope link src 10.0.2.1
10.16.0.0/16 dev eth0 proto kernel scope link src 10.16.0.25
bash-5.1$ ./brctl show
bridge name     bridge id               STP enabled     interfaces
k6t-eth0                8000.020000000000       no              tap0
bash-5.1$ ip a
1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host
       valid_lft forever preferred_lft forever
2: k6t-eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1400 qdisc noqueue state UP group default
    link/ether 02:00:00:00:00:00 brd ff:ff:ff:ff:ff:ff
    inet 10.0.2.1/24 brd 10.0.2.255 scope global k6t-eth0
       valid_lft forever preferred_lft forever
    inet6 fe80::ff:fe00:0/64 scope link
       valid_lft forever preferred_lft forever
3: tap0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1400 qdisc fq_codel master k6t-eth0 state UP group default qlen 1000
    link/ether b6:87:36:f4:9b:8a brd ff:ff:ff:ff:ff:ff
    inet6 fe80::b487:36ff:fef4:9b8a/64 scope link
       valid_lft forever preferred_lft forever
75: eth0@if76: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1400 qdisc noqueue state UP group default
    link/ether 00:00:00:e6:52:13 brd ff:ff:ff:ff:ff:ff link-netnsid 0
    inet 10.16.0.25/16 brd 10.16.255.255 scope global eth0
       valid_lft forever preferred_lft forever
    inet6 fe80::200:ff:fee6:5213/64 scope link
       valid_lft forever preferred_lft forever
```

**k8s节点层面**
```yaml
[root@vm26 ~]# ip a
76: ef1d592ced89_h@if75: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1400 qdisc noqueue master ovs-system state UP group default qlen 1000
    link/ether e2:ed:1d:c1:8b:4e brd ff:ff:ff:ff:ff:ff link-netnsid 0
    inet6 fe80::e0ed:1dff:fec1:8b4e/64 scope link 
       valid_lft forever preferred_lft forever76: ef1d592ced89_h@if75: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1400 qdisc noqueue master ovs-system state UP group default qlen 1000
    link/ether e2:ed:1d:c1:8b:4e brd ff:ff:ff:ff:ff:ff link-netnsid 0
    inet6 fe80::e0ed:1dff:fec1:8b4e/64 scope link 
       valid_lft forever preferred_lft forever
[root@vm24 ~]# kubectl ko vsctl vm26 show
9a3df829-3706-4c1d-bd7a-85cc0c9061c5
    Bridge br-int
        fail_mode: secure
        datapath_type: system
        Port ef1d592ced89_h
            Interface ef1d592ced89_h
        ...
    ovs_version: "2.17.7"
# 查看ovn南向连接状态
[root@vm24 ~]# kubectl ko sbctl show
Chassis "f1a48d0c-42b0-43ba-894c-09089e7e0df9"
    hostname: vm24
    Encap geneve
        ip: "192.168.101.24"
        options: {csum="true"}
    Port_Binding cdi-deployment-69d44b67b5-65v7d.cdi
    ...
Chassis "a54d8da5-1c31-4180-bd39-bdc7bcaf41cc"
    hostname: vm25
    Encap geneve
        ip: "192.168.101.25"
        options: {csum="true"}
    Port_Binding virt-operator-6dfbd947b4-fppk4.kubevirt
    ...
Chassis "5e051e73-b926-470d-9c99-8f1604b7bf8d"
    hostname: vm26
    Encap geneve
        ip: "192.168.101.26"
        options: {csum="true"}
    Port_Binding testvm.default
    ...
# 查看ovn北向连接状态
[root@vm24 ~]# kubectl ko nbctl show
switch cf603059-294b-4147-a3b4-98ddb45cb051 (ovn-default)
    port testvm.default
        addresses: ["00:00:00:E6:52:13 10.16.0.25"]
    port virt-handler-hxbpw.kubevirt
        addresses: ["00:00:00:CC:6D:4D 10.16.0.23"]
    ...
switch 626913df-9994-42ad-96e3-330a8fec1f08 (join)
    port node-vm25
        addresses: ["00:00:00:72:50:54 100.64.0.3"]
    port node-vm24
        addresses: ["00:00:00:49:34:29 100.64.0.2"]
    port node-vm26
        addresses: ["00:00:00:0A:39:76 100.64.0.4"]
    port join-ovn-cluster
        type: router
        router-port: ovn-cluster-join
router e0926da7-aca3-4c41-821d-3bc5305ebf1c (ovn-cluster)
    port ovn-cluster-join
        mac: "00:00:00:42:79:A9"
        networks: ["100.64.0.1/16"]
    port ovn-cluster-ovn-default
        mac: "00:00:00:BE:79:30"
        networks: ["10.16.0.1/16"]
```


目前kubevirt支持的配置：

### pod网络，桥接方式

在网桥模式下，虚拟机通过一个 linux网桥连接到网络后端。这种方式会导致pod没有ip（给了虚拟机），在使用第三方mesh网络如Istio会不兼容，官网有提示。

```yaml
    spec:
      domain:
        devices:
          interfaces: # 前端
            - bridge: {}
              name: default
              ports:
                - name: ssh
                  port: 22
      networks: # 后端
        - name: default
          pod: {}
```


### pod网络，masquerade(伪装)方式

在伪装模式下，KubeVirt 将内部 IP 地址分配（DHCP）给虚拟机，并将它们隐藏在 NAT 之后。所有退出虚拟机的通信都是使用 pod IP 地址进行NAT的。

```yaml
    spec:
      domain:
        devices:
          interfaces: # 前端
            - masquerade: {}
              name: default
              ports:
                - name: ssh
                  port: 22
      networks: # 后端
        - name: default
          pod: {}
```
### VM热迁移

KubeVirt热迁移在固定 IP 的场景下，由于 KubeVirt 在热迁移中使用 default network 进行状态的同步，通过结合 multus-cni 将业务网络和迁移网络分离，可以在功能层面实现热迁移过程中的地址固定。

使用kube-ovn注解可以使pod或vm固定ip：
```yaml
apiVersion: kubevirt.io/v1alpha3
kind: VirtualMachine
metadata:
  name: testvm
spec:
  template:
    metadata:
      annotations:
        ovn.kubernetes.io/ip_address: 10.16.0.15
```

kube-ovn针对kubevirt场景提供了`--keep-vm-ip=true`参数，能够在VM生命周期内保持IP不变。


### 网络直通与高性能网络

由于VM网络可以直接使用POD网络，所以通过multus-cni可以对POD/VM配置多个网卡。在某些场景下，如需要给POD/VM分配一个节点网段的IP就需要挂载直通网络到POD/VM，主流的方案有以下几种：

#### macvtap + multus

macvtap是kubevirt官方推行的一种方式，能够分配给VM一个MAC使VM与k8s节点处于L2同一层网络。

目前仍属于特性开关阶段。试了一下能够分配MAC但是无IP。、

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: dataplane
  namespace: default
spec:
  config: >-
    { "cniVersion": "0.3.1", "name": "dataplane", "type": "macvtap", "mtu": 1500
    }
---
    spec:
      domain:
        devices:
          interfaces:
            - macvtap: {}
              name: attachnet
            - masquerade: {}
              name: default
      networks:
        - multus:
            networkName: dataplane
          name: attachnet
        - name: default
          pod: {}
```

#### macvlan + multus + 桥接 + 单网卡 

macvlan方式在POD上能正常工作，但是由于kubevirt VM网络的特性，会占用POD的MAC（官网有解释），导致无法正确配置POD网络。

```yaml
    spec:
      domain:
        devices:
          interfaces:
            - bridge: {}
              name: default
              ports:
                - name: ssh
                  port: 22
      networks:
        - multus:
            networkName: default/macvlaneip
          name: default
```


#### ipvlan + multus + 桥接 + 单网卡

ipvlan需要Linux内核高版本支持，与macvlan一样同样存在问题。

[invalid-cnis-for-secondary-network](https://kubevirt.io/user-guide/virtual_machines/interfaces_and_networks/#invalid-cnis-for-secondary-networks)

有待研究的方案：

- sriov + multus
- dpdk结合：目前kube-von的dpdk方案还不成熟，只有商用版提供。
- underlay模式打通pod和VM和k8s节点的网络


以上方式均直接与节点上的物理网络直接联通，所以网络流向是无法经过ovn的ovs，从而也无法做到隔离的要求。因此需要考虑一种既能高效给VM分配网络也能对网络设备进行策略和限制的方法。目前没有成熟的方案。

#### 与社区讨论的方案：vhost补丁 + 策略/挂载（需要定制化开发）

vhost 补丁是一种用于优化虚拟机网络性能的技术。在传统的虚拟化技术中，虚拟机网络通信需要经过虚拟交换机和虚拟网卡，这会导致一定的性能损失。而使用 vhost 补丁，可以将虚拟机网络通信的处理流程转移到宿主机的内核空间中，从而避免了虚拟交换机和虚拟网卡的性能损失。这样可以显著提高虚拟机网络性能。

## 与传统OVN的区别

kube-ovn实际上使用的是传统ovn的能力而且实现了CNI功能为POD提供网络能力，并且以k8s作为部署的方式。可以理解为部署了一套ovn的同时实现了CNI的功能来解决k8s的网络问题。因此如果能将cni功能单独抽出来做成“可以对接OVN的CNI组件”既能满足可拆可堆叠的系统。

从OVN系统获取一个IP的详细过程如下:

1) OVN控制器从地址池选择一个可用IP

2) OVN控制器更新ovs数据库,将IP绑定到虚拟机接口

3) ovn-sb通过流表在OVS实现IP和接口的绑定

4) 虚拟机通过DHCP或手动配置获取绑定的IP

5) 虚拟机使用该IP与外部网络通信

整个过程由OVN控制器自动完成。

而kube-ovn的区别如下：

1) kube-ovn在OVN中创建逻辑网络和预分配IP地址池

2) Pod创建时,kube-ovn在OVN中为Pod创建逻辑port

3) kube-ovn从地址池为Pod选择一个IP并绑定到逻辑port

4) kube-ovn在K8S为Pod的接口配置选择的IP地址 

5) kubelet根据IP配置Pod网络,Pod使用该IP与OVN通信

6) Pod删除时,kube-ovn释放逻辑port的IP回收到地址池

整个过程由kube-ovn控制器自动完成,K8S用户不需要任何操作。

因此，这里的区别是给虚拟机分配IP和给容器分配IP，需要一个统一的方法。


## 总结

Kube-OVN是一个基于OVN和Kubernetes的网络解决方案，具有多租户网络、多网络拓扑、灵活的网络策略和高度自动化等特点，还能通过集成其他cni插件如Cilium来加速网络。通过软件交换机的方式打通网络，配合multus-cni多网卡，对于容器直通能够比较好的支持,kubevirt虚拟机直通也有比较多的方案。

目前kube-ovn仍在处于发展阶段，许多特性成熟度仍在Alpha阶段：Cilium 集成、DPDK 支持、Underlay 和 Overlay 互通等。

更加深入ovn相关的知识，有待充电。参考下方的文档链接。


## 名词解释

| 名词 | 英文或缩写 | 解释 |
|:------|:------|:------|
| OVS | Open vSwitch | 是一种开源的虚拟交换机，它通过软件定义网络（SDN）技术实现了高性能的虚拟网络功能。 |
| OVN | Open Virtual Network | 在OVS之上构建的一种虚拟网络解决方案，它提供了以逻辑为基础的网络虚拟化功能和服务。 |
| VLAN | Virtual Local Area Network   | 虚拟局域网。它是一种将物理局域网划分为多个逻辑上的虚拟子网的技术。   |
| MacVLAN | - | MacVLAN是一种Linux内核网络驱动程序，它可以实现虚拟化多个物理网络接口（NIC）并为每个虚拟接口分配一个唯一的MAC地址，从而使得每个虚拟接口可以像独立的物理接口一样运行。 |
| VXLAN | - | VXLAN是一种网络虚拟化技术，它可以扩展虚拟局域网（VLAN）的数量，提高虚拟网络的可扩展性。VXLAN通过将VLAN封装在UDP数据包中，实现了在物理网络之上建立逻辑网络的功能，从而实现了跨物理网络的通信。 |
| Overlay网络 | -   | 一种虚拟网络，它是建立在底层物理网络之上的。Overlay网络可以将多个物理网络连接成一个逻辑网络，从而实现跨物理网络的通信。   |
| Underlay网络 | -   | 底层物理网络，它是构成Overlay网络的基础设施。Underlay网络是由物理设备、物理链路和物理协议组成的，它负责传输Overlay网络中的数据包。|
|IPAM|Internet Protocol Address Management|一种网络管理方法，用于管理和分配 IP 地址和子网。它通常用于大型企业、ISP（Internet Service Provider）和数据中心等组织，以帮助管理和优化网络地址使用。|
|VPC|Virtual Private Cloud|是一种虚拟化的网络环境，它可以在公共云上创建一个私有的、隔离的网络环境，使得用户可以在这个网络环境中运行其计算资源和应用程序，同时也可以控制网络的访问和安全性。|
|QoS|Quality of Service|一种网络管理方法，用于优化网络资源的使用和分配，以提供更高的网络性能、可靠性和可用性，同时满足不同类型的网络流量对网络的不同要求。|
|CIDR |Classless Inter-Domain Routing|一种 IP 地址分配和路由选择的方法，它可以更有效地利用 IP 地址，并简化网络地址的管理和配置。例如“192.168.1.0/24”，其中“/24”表示网络前缀有 24 位。|
|Geneve |Generic Network Virtualization Encapsulation|一种网络虚拟化协议，用于在云计算和虚拟化环境中实现网络隔离和多租户网络，好比下一代vxlan|
|南北流量|North-South Traffic|指在网络中从内部网络流向外部网络（例如从企业内部网络流向公共互联网）的流量。|
|东西流量|East-West Traffic|指在网络中从内部网络中的一个子网或部门流向另一个子网或部门的流量。与南北流量不同，东西流量主要发生在内部网络中，通常不需要经过网络边界设备进行转发和处理，而是直接在内部网络中进行通信。|

## 环境信息

xen,开启仿真模式：http://192.168.101.24:30036/
kvm: http://192.168.239.122:30036/

## 使用过程中遇到的问题

1、使用kube-ovn配置外部网关过程中，配置ovn-external-gw-config时，误将external-gw-nic设置成eth0即节点主要的沟通网卡，导致节点无法ssh连接，也无法ping通内外网络。该节点成为了孤岛，重启无效。询问社区也无法解决。最后在集群删除节点然后恢复快照，重新添加到集群解决。

2、ovn-external-gw-config配置外部网关错误导致虚拟交换机与物理交换机形成环路，同一局域网内网络崩溃（待确认），相关issue：https://github.com/kubeovn/kube-ovn/issues/2184

3、在k3s+kube-ovn+multus-cni+kubevirt+kvm环境下创建的虚拟机，出现ssh无法连接的情况，可能跟内核版本有关，待排查。

4、部署k3s时使用环境变量会将环境变量持久化到`/etc/systemd/system/k3s.service.env`文件。如果使用代理可能会造成k3s无法访问pod或者svc网络。

5、与kube-ovn结合使用时，如果使用ovn做容器网络，macvlan、ipvlan等方式无法桥接到vm使用，无法使用ovs网络模型。

6、目前只能通过vm使用pod的网络的方式使用ovs网络模型，但是性能待测试。（如果采用underlay模式则无法做到vpc隔离）

7、资源占用问题，每一个pod需要qemu、virt-launcher、virt-launcher-monitor进程





## 参考文档

[kubeovn](https://kubeovn.github.io/docs/v1.11.x/)

[基于 OVN 的 Kubernetes 网络架构解析](https://toutiao.io/posts/0s3ct9/preview)

[ovn-architecture](https://www.mankier.com/7/ovn-architecture)

[KubeVirt-Network-Deep-Dive](https://kubevirt.io/2018/KubeVirt-Network-Deep-Dive.html)

## 附件

### 网络性能基准测试

环境信息：

| 组件 | 版本 | 
|:------|:------|
| k3s | v1.26.4+k3s1 | 
| kube-ovn | v1.11.3 | 
| ovs | 2.17.7 | 
| kubevirt | v1.0.0-alpha.0 | 
| node * 3 | 3.10.0-1160.el7.x86_64 16Core 16G | 

### msg_size:4KiB 

使用以下命令进行测试：
`qperf -t 60 server-ip -ub -oo msg_size:4K -vu tcp_lat tcp_bw udp_lat udp_bw`

结果：

| Flow | tcp_lat | udp_lat | tcp_bw  | udp_send_bw  |  udp_recv_bw  |
|:-----|:-------------|:-------------|:--------------|:-------------|:-------------|
| node-to-node | 86.8 us | 98.7 us |  8.99 Gb/sec | 2.77 Gb/sec  | 1.94 Gb/sec  |
| pod-to-pod(in-cluster-cross-node) | 145 us | 144 us | 2.4 Gb/sec | 1.88 Gb/sec | 1.21 Gb/sec |
| pod-to-pod(in-cluster-in-node) | 47.7 us | 28.5 us | 1.03 Gb/sec | 1.42 Gb/sec | 1.41 Gb/sec |
| pod-to-pod(cross-cluster) | 2.24 ms | 2.25 ms | 858 Mb/sec | 1.91 Gb/sec | 8.23 Mb/sec |
