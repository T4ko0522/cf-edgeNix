{
  description = "CF-EdgeNix — Cloudflare-native Nix binary cache";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-vite-plus.url = "github:ryoppippi/nix-vite-plus";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    nix-vite-plus,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {inherit system;};
        workerd = pkgs.writeShellScriptBin "workerd-nix" ''
          workerd="$(${pkgs.nodejs_22}/bin/node -p 'require("workerd").default')"

          export NIX_LD="${pkgs.stdenv.cc.bintools.dynamicLinker}"
          export NIX_LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [pkgs.glibc]}"

          exec ${pkgs.nix-ld}/bin/nix-ld "$workerd" "$@"
        '';
      in {
        devShells.default = pkgs.mkShell (
          {
            packages =
              [
                nix-vite-plus.packages.${system}.vp
              ]
              ++ (with pkgs; [
                bun
                nodejs_22
                git
                zstd
                nix
              ]);
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
            MINIFLARE_WORKERD_PATH = "${workerd}/bin/workerd-nix";
          }
        );
      }
    );
}
