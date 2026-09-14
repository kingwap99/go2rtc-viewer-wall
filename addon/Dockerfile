ARG BUILD_FROM
FROM $BUILD_FROM

WORKDIR /app

COPY server.py run.sh ./
COPY index.html ./
COPY css ./css
COPY js ./js
COPY assets ./assets

RUN chmod a+x /app/run.sh

CMD [ "/app/run.sh" ]
