{
  description = "CF-EdgeNix — Cloudflare-native Nix binary cache";

  nixConfig = {
    extra-substituters = [
      "https://nix.t4ko.pet"
      "https://vicinae.cachix.org"
      "https://cache.numtide.com"
      "https://codex-desktop-linux.cachix.org"
      "https://noctalia.cachix.org"
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix.t4ko.pet-1:0eRO18L1/5diWYWboKKPTejQGhGCHNITwELiUaX7Kps="
      "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc="
      "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g="
      "codex-desktop-linux.cachix.org-1:nX/xy6AdK9hQE24A8ALGjkCKj2ObFmcnemiL5Cid4nk="
      "noctalia.cachix.org-1:pCOR47nnMEo5thcxNDtzWpOxNFQsBRglJzxWPp3dkU4="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

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
                jq
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
