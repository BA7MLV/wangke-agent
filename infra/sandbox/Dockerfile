FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /workspace && chown node:node /workspace
COPY --chmod=755 infra/sandbox/save-file.py /usr/local/bin/wangke-save
USER node
WORKDIR /workspace
ENV HOME=/workspace
CMD ["bash"]
