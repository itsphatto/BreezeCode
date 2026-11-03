import java.util.Scanner;

public class Ask {
  static int add(int a, int b) { int s = a + b; return s; }
  public static void main(String[] args) {
    int x = 2;
    int[] nums = { 4, 5 };
    System.out.println("name?");
    String name = new Scanner(System.in).nextLine();
    int z = add(x, nums[1]);
    System.out.println("hi " + name + " " + z);
    if (z > 100) throw new IllegalStateException("too big: " + z);
  }
}
