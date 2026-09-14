# Supervisor's app builder may not pass BUILD_FROM for base image selection,
# so keep a working multi-arch default (python image, stdlib-only server).
ARG BUILD_FROM=python:3.12-alpine
FROM $BUILD_FROM

WORKDIR /app

COPY server.py run.sh ./
COPY index.html ./
COPY css ./css
COPY js ./js
COPY assets ./assets

RUN chmod a+x /app/run.sh

CMD [ "/app/run.sh" ]
