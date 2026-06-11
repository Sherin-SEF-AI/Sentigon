"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 active:scale-[.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground elev-1 hover:bg-accent hover:shadow-[0_0_14px_rgba(34,211,238,.35)]",
        secondary: "bg-secondary text-secondary-foreground border border-border hover:bg-surface-3 hover:border-border-strong",
        destructive: "bg-destructive text-destructive-foreground elev-1 hover:bg-destructive/85 hover:shadow-[0_0_14px_rgba(239,68,68,.35)]",
        outline: "border border-border bg-transparent text-foreground hover:bg-secondary/60 hover:border-border-strong",
        ghost: "bg-transparent text-foreground hover:bg-secondary/60",
        link: "bg-transparent text-primary underline-offset-4 hover:underline hover:text-accent",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-10 px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
