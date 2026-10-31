package app.shubian.dict;

import android.content.*;import android.database.*;import android.database.sqlite.*;import java.io.*;import java.util.*;

public final class DictDatabase {
 public static final class Entry { public final String word, phonetic, trans; public final Integer rank; Entry(String w,String p,String t,Integer r){word=w;phonetic=p;trans=t;rank=r;} public List<String> senses(){List<String> out=new ArrayList<>(); for(String line:trans.split("\\n")){String s=line.replaceFirst("^[a-zA-Z. ]+"," ").trim(); for(String x:s.split("[,，;；]")){x=x.trim();if(!x.isEmpty()&&!out.contains(x))out.add(x);}} return out;} }
 private final SQLiteDatabase db;
 private DictDatabase(SQLiteDatabase d){db=d;}
 public static DictDatabase open(Context ctx) throws IOException { File f=ctx.getDatabasePath("dict.db"); if(!f.exists()){f.getParentFile().mkdirs(); try(InputStream in=ctx.getAssets().open("dict.db");OutputStream out=new FileOutputStream(f)){byte[] b=new byte[8192];int n;while((n=in.read(b))>0)out.write(b,0,n);}} return new DictDatabase(SQLiteDatabase.openDatabase(f.getPath(),null,SQLiteDatabase.OPEN_READONLY)); }
 public Entry lookup(String raw){String q=raw.toLowerCase(Locale.ROOT).trim(); if(q.isEmpty())return null; Cursor c=db.rawQuery("SELECT word,phonetic,trans,rank FROM entry WHERE word=?",new String[]{q}); try{if(c.moveToFirst())return row(c);}finally{c.close();} Cursor f=db.rawQuery("SELECT lemma,kind FROM form WHERE form=?",new String[]{q}); try{if(f.moveToFirst()){String lemma=f.getString(0); Entry e=lookup(lemma); if(e!=null)return new Entry(e.word,e.phonetic,e.trans,e.rank);} }finally{f.close();} for(String stem:new String[]{q.replaceFirst("(ing|ed|es|s|ly)$",""),q.replaceFirst("ies$","y")}){if(!stem.equals(q)){Entry e=lookup(stem);if(e!=null)return e;}} return null; }
 public List<Entry> prefix(String raw,int limit){String q=raw.toLowerCase(Locale.ROOT);List<Entry> out=new ArrayList<>();if(q.isEmpty())return out;Cursor c=db.rawQuery("SELECT word,phonetic,trans,rank FROM entry WHERE word>=? AND word<? ORDER BY length(word),COALESCE(rank,999999) LIMIT ?",new String[]{q,q+Character.MAX_VALUE,String.valueOf(limit)});try{while(c.moveToNext())out.add(row(c));}finally{c.close();}return out;}
 private Entry row(Cursor c){return new Entry(c.getString(0),c.getString(1),c.getString(2),c.isNull(3)?null:c.getInt(3));}
}
