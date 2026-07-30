FROM apify/actor-node:22

# `apify` is installed here rather than declared in package.json on purpose.
#
# The scanner core imports nothing outside Node's standard library, and a tool
# whose job is detecting supply-chain traps should not make every CLI user
# install an SDK they never execute. Only src/actor.js needs the SDK, and only
# on the platform — so the platform image is where it belongs. `npm ls` output
# below makes the whole installed tree visible in the build log.
COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && npm install --quiet --save apify \
    && echo "--- installed dependency tree ---" \
    && npm ls --omit=dev --all || true

COPY . ./

CMD ["node", "src/actor.js"]
