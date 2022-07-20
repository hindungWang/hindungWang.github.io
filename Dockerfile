FROM klakegg/hugo
COPY . /data
WORKDIR /data
CMD ["server", "-t", "terminal"]