import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
const db = new PrismaClient();
const names = ['Odia','Local','Desi','Lover','Romance','Entertainment','Web Series','Shorts','Movies','Music','Comedy','Drama','Trending','Viral','Lifestyle','Dance','Stories','Regional','New Releases','Others'];
for (const name of names) { const slug = name.toLowerCase().replace(/\s+/g,'-'); await db.category.upsert({where:{slug},update:{name},create:{name,slug}}); }
const email=process.env.ADMIN_EMAIL, password=process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 12 || password==='CHANGE_THIS_TO_A_STRONG_PASSWORD') throw Error('Set ADMIN_EMAIL and strong ADMIN_PASSWORD (12+ chars) in .env');
await db.user.upsert({where:{email},update:{role:'ADMIN'},create:{email,name:'Administrator',role:'ADMIN',passwordHash:await argon2.hash(password)}});
console.log('Seeded 20 categories and admin:',email);
await db.$disconnect();
