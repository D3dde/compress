{
  description = "Squeeze — compress a video to an exact target size, entirely in the browser";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          name = "squeeze-dev";

          packages = [
            pkgs.nodejs_24
            # Only used to throw test clips at the encoder while developing.
            pkgs.ffmpeg
            pkgs.git
          ];

          shellHook = ''
            echo "squeeze dev shell · node $(node --version) · npm $(npm --version)"
            echo "  npm install && npm run dev   # http://localhost:5173"
          '';
        };
      });

      packages = forAllSystems (pkgs: let
        # Exactly what the build needs, so node_modules and dist/ never reach
        # the store.
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./README.md
            ./.gitignore
            ./.oxlintrc.json
            ./index.html
            ./package.json
            ./package-lock.json
            ./tsconfig.app.json
            ./tsconfig.json
            ./tsconfig.node.json
            ./vite.config.ts
            ./src
            ./scripts
            ./public
          ];
        };

        npmEnv = {
          # npm insists on a writable HOME and cache; the sandbox has neither.
          HOME = "/build/fake-home";
          npm_config_cache = "/build/.npm-cache";
          npm_config_audit = "false";
          npm_config_fund = "false";
        };

        # The dependency tree is fetched once in a fixed-output derivation, so
        # the build itself never touches the network and stays reproducible.
        # --ignore-scripts keeps third-party install hooks out of the builder.
        npmDeps = pkgs.stdenvNoCC.mkDerivation {
          pname = "squeeze-npm-deps";
          inherit version src;

          # cacert is what lets the sandboxed npm trust registry.npmjs.org.
          nativeBuildInputs = [
            pkgs.nodejs_24
            pkgs.cacert
          ];
          env = npmEnv;

          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
          outputHash = "sha256-+LAdwVvF5iJovYGeQPounwkQI+kYPFt8TLLayxl3iqo=";

          dontConfigure = true;
          dontFixup = true;

          buildPhase = ''
            runHook preBuild
            mkdir -p "$HOME" "$npm_config_cache"
            npm ci --ignore-scripts
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -r node_modules "$out/node_modules"
            runHook postInstall
          '';
        };
      in
      {
        squeeze = pkgs.stdenvNoCC.mkDerivation {
          pname = "squeeze";
          inherit version src;

          nativeBuildInputs = [ pkgs.nodejs_24 ];
          env = npmEnv;

          dontConfigure = true;

          buildPhase = ''
            runHook preBuild
            mkdir -p "$HOME" "$npm_config_cache"
            cp -r ${npmDeps}/node_modules ./node_modules
            chmod -R u+w node_modules
            # The same commands as "npm run build", invoked through node
            # directly: the shims in node_modules/.bin have #!/usr/bin/env
            # shebangs and the Nix sandbox has no /usr/bin/env.
            node node_modules/typescript/bin/tsc -b
            node node_modules/vite/bin/vite.js build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p "$out/share/squeeze"
            cp -r dist "$out/share/squeeze/dist"
            mkdir -p "$out/bin"
            # Written by hand rather than with writeShellScript: an absolute
            # shebang keeps the launcher independent of the caller's PATH.
            cat > "$out/bin/squeeze" <<EOF
            #!${lib.getExe pkgs.bash}
            exec ${lib.getExe pkgs.nodejs_24} ${./scripts/serve.mjs} --root "$out/share/squeeze/dist" "$@"
            EOF
            chmod +x "$out/bin/squeeze"
            runHook postInstall
          '';

          meta = {
            description = "Static site that compresses a video to a target file size in the browser";
            mainProgram = "squeeze";
            platforms = systems;
            sourceProvenance = true;
          };
        };

        default = self.packages.${pkgs.stdenv.hostPlatform.system}.squeeze;
      });

      apps = forAllSystems (pkgs: {
        # Serves the built site on http://127.0.0.1:4173 with the cross-origin
        # isolation headers that multi-threaded ffmpeg requires.
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.squeeze}/bin/squeeze";
        };
      });

      checks = forAllSystems (pkgs: {
        # `nix flake check` builds the site, which typechecks along the way.
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.squeeze;
      });
    };
}