using System;

static int Add(int a, int b) { var s = a + b; return s; }

var x = 2;
Console.WriteLine("name?");
var name = Console.ReadLine();
var z = Add(x, 3);
Console.WriteLine($"hi {name} {z}");
if (z > 100) throw new InvalidOperationException($"too big: {z}");
