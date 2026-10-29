// Tiny CLI around meshoptimizer's simplifier.
// stdin:  uint32 nverts, uint32 nidx, float32 target_ratio, float32 abs_error, uint32 options,
//         float32[nverts*3] positions, uint32[nidx] indices
// stdout: uint32 nidx_out, float32 result_error, uint32[nidx_out] indices
#include "meshoptimizer.h"   // build: g++ -O2 -std=c++17 -I<meshoptimizer>/src simplify.cpp <meshoptimizer>/src/*.cpp
#include <cstdio>
#include <cstdint>
#include <vector>
int main() {
  uint32_t nv, ni, opt; float ratio, err;
  if (fread(&nv, 4, 1, stdin) != 1 || fread(&ni, 4, 1, stdin) != 1 || fread(&ratio, 4, 1, stdin) != 1 ||
      fread(&err, 4, 1, stdin) != 1 || fread(&opt, 4, 1, stdin) != 1) return 1;
  std::vector<float> pos(size_t(nv) * 3);
  std::vector<uint32_t> idx(ni), out(ni);
  if (fread(pos.data(), 4, pos.size(), stdin) != pos.size() || fread(idx.data(), 4, ni, stdin) != ni) return 2;
  size_t target = size_t(ni * ratio) / 3 * 3;
  float resErr = 0;
  size_t n = meshopt_simplify(out.data(), idx.data(), ni, pos.data(), nv, 12, target, err, opt | meshopt_SimplifyErrorAbsolute, &resErr);
  uint32_t n32 = uint32_t(n);
  fwrite(&n32, 4, 1, stdout); fwrite(&resErr, 4, 1, stdout); fwrite(out.data(), 4, n, stdout);
  return 0;
}
