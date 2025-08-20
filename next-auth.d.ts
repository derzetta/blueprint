import NextAuth from "next-auth"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      name?: string | null
      email?: string | null
      image?: string | null
      role: string
    }
  }

  interface User {
    id: string
    name?: string | null
    email?: string | null
    image?: string | null
    role: string
  }
}

declare module "next-auth/adapters" {
  interface AdapterUser {
    id: string
    name?: string | null
    email: string
    emailVerified?: Date | null
    image?: string | null
    role: string
  }
}

declare module "@auth/core/adapters" {
  interface AdapterUser {
    id: string
    name?: string | null
    email: string
    emailVerified?: Date | null
    image?: string | null
    role: string
  }
}