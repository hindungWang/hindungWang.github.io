# start up

docker run -ti -p80:8080 -v /data/public:/app/public -v /data/nginx.conf:/etc/nginx/conf.d/default.conf -d --name blog --rm nginx

# visit

hindung.cn
