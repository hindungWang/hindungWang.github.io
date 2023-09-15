---
title: K8s client-go初始化的几种方法
Date: 2022-07-19
description: 经常用到的集中k8s client的初始化方法，这里总结备忘📝一下
tags:
  - Kubernetes
  - Go
---

## 简介

client-go是k8s的一个基础组件库，是用于与API-Server交互的http客户端。K8s中大部分组件都使用了这个库实现与API-Server的通信功能。除了能够对资源对象的增删改查，还可Watch一个对象、升级成websocket链接等等功能。




client-go支持四种客户端：`RESTClient`、`ClientSet`、`DynamicClient`、`DiscoveryClient`。这几个client可以相互转换。




### RESTClient

RESTClient是最基础的客户端，相当于最底层的基础结构，可以直接通过RESTClient提供的RESTful方法如Get()、Put()、Post()、Delete()进行交互。

一般而言，为了更为优雅的处理，需要进一步封装，通过Clientset封装RESTClient，然后再对外提供接口和服务。

可以通过ClientSet客户端获得：

```go
client := cli.CoreV1().RESTClient().(*rest.RESTClient)
```

### ClientSet

Clientset是调用Kubernetes资源对象最常用的client，可以操作所有的资源对象，包含RESTClient。需要制定Group、Version，然后根据Resource获取。

```go
clientset,err := kubernetes.NewForConfig(config)
sa, err := clientset.CoreV1().ServiceAccounts("kube-system").Get("kube-shell-admin", metav1.GetOptions{})
```

### DynamicClient

Dynamic client是一种动态的client，它能处理kubernetes所有的资源。不同于clientset，dynamic client返回的对象是一个`map[string]interface{}`。

```go
dynamicClient,err := dynamic.NewForConfig(config)
gvr := schema.GroupVersionResource{Version: "v1",Resource: "pods"}
unstructObjList,err := dynamicClient.Resource(gvr).Namespace("dev").List(context.TODO(),metav1.ListOptions{Limit: 100})
```
### DiscoveryClient

DiscoveryClient是发现客户端，主要用于发现kubernetes API Server所支持的资源组、资源版本、资源信息。除此之外，还可以将这些信息存储到本地，用户本地缓存，以减轻对Kubernetes API Server访问的压力。 kubectl的api-versions和api-resources命令输出也是通过DisconversyClient实现的。

```go
discoveryClient,err := discovery.NewDiscoveryClientForConfig(config)
APIGroup,APIResourceListSlice,err := discoveryClient.ServerGroupsAndResources()
```

这几种客户端的初始化都涉及到了入参config，即`*rest.Config`，这个是用于初始化客户端的所有配置信息。

## rest.Config初始化

创建client前，需要先从初始化`*rest.Config`，这个`*rest.Config`可以从集群外的kubeconfig文件或者集群内部的 tokenFile 和 CAFile初始化（通过ServiceAcount自动挂载）。有以下几种方式：

### 集群外通过kubeconfig初始化

BuildConfigFromFlags方法从给定的url或者kubeconfig文件的文件夹路径去初始化config，如果不成功则会使用集群内部方法初始化config，如果不成功则返回一个默认的config。
```go
// "k8s.io/client-go/tools/clientcmd"
config, err := clientcmd.BuildConfigFromFlags("", *kubeconfig)
if err != nil {
   panic(err.Error())
}
```
### 内存中通过kubeconfig字符串或者byte数组初始化

通过读取kubeconfig文件内容进行初始化一个config：

```go
config, err := clientcmd.NewClientConfigFromBytes([]byte(string(Data["kubeConfig"])))
if err != nil {
   return nil, err
}
restConfig, err := config.ClientConfig()
if err != nil {
   return nil, err
}
```
### 集群中通过ServiceAcount初始化

通过集群内部配置创建 k8s 配置信息，通过 KUBERNETES_SERVICE_HOST 和 KUBERNETES_SERVICE_PORT 环境变量方式获取。

若集群使用 TLS 认证方式，则默认读取集群内部 tokenFile 和 CAFile：

`tokenFile = "/var/run/secrets/kubernetes.io/serviceaccount/token"`

`rootCAFile = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"`

```go
// "k8s.io/client-go/rest"
config, err := rest.InClusterConfig()
if err != nil {
   panic(err.Error())
}
```

### operator-sdk中初始化config

一般来说，我们使用operator-sdk开发CRDs都会用到在本地调试或者在集群中调试的方法，在低版本operator-sdk中可以使用以下方法：

```go
// "sigs.k8s.io/controller-runtime/pkg/client/config"
cfg, err := config.GetConfig()
if err != nil {
log.Error(err, "")
   os.Exit(1)
}
```

该方法初始化kubeconfig的顺序是--kubeconfig标签，KUBECONFIG环境变量，In-cluster集群内SA，$HOME/.kube/config文件。

在初始化的config的同时，设置了请求的QPS，默认20 QPS, 30 burst。

在某些高版本sdk中，可以用以下方法初始化：

```go
//ctrl "sigs.k8s.io/controller-runtime"
ctrl.GetConfigOrDie()
```

原理同上。