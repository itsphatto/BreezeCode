#include <cstdio>
#include <string>
int main() {
  std::string word = "spin";
  long n = 0;
  for (;;) {
    n++;
    if (n % 100000000 == 0) std::printf("%s %ld\n", word.c_str(), n);
  }
}
