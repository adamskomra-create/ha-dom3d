ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache python3 py3-aiohttp

COPY app/ /app/
WORKDIR /app

RUN chmod a+x /app/run.sh
CMD ["/app/run.sh"]
