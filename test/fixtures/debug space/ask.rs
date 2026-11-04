use std::io::BufRead;
fn add(a: i32, b: i32) -> i32 { let s = a + b; s }
fn main() {
    let x = 2;
    println!("name?");
    let name = std::io::stdin().lock().lines().next().unwrap().unwrap();
    let z = add(x, 3);
    println!("hi {} {}", name, z);
}
