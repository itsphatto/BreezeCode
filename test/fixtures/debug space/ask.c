#include <stdio.h>
int add(int a, int b) { int s = a + b; return s; }
int main(void) {
  int x = 2, y = 3;
  printf("name?\n");
  char name[32] = {0};
  if (scanf("%31s", name) == 1) printf("hi %s\n", name);
  int z = add(x, y);
  printf("z = %d\n", z);
  return 0;
}
