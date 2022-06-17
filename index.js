require("dotenv").config();

const axios = require("axios").default,
  fs = require("fs"),
  cheerio = require("cheerio"),
  args = require("minimist")(process.argv.slice(2)),
  nodemailer = require("nodemailer"),
  hbs = require("nodemailer-express-handlebars"),
  path = require("path"),
  fb = require("./store.js"),
  store = fb.firebase.firestore();

let sites = JSON.parse(fs.readFileSync("sites.json"));

const failed = [];
const success = [];

const getHtmlAxios = async (url) => {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.74 Safari/537.36",
    },
  });

  return data;
};

const extractPrices = ($, selector) => {
  let price = {};

  // If there's more than one price (discounts for higher quantity)
  if (typeof selector === "object") {
    // 100 Gallon Price
    if (selector.hasOwnProperty("100")) {
      let p = Number(
        $(selector["100"])
          .text()
          .match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2,3})/)
      );

      price = {
        ...price,
        oneHundred: p,
        oneFifty: p,
        twoHundred: p,
      };
    }

    // 150 Gallon Price
    if (selector.hasOwnProperty("150")) {
      let p = Number(
        $(selector["150"])
          .text()
          .match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2,3})/)
      );

      price = {
        ...price,
        oneFifty: p,
        twoHundred: p,
      };
    }

    // 200 Gallon Price
    if (selector.hasOwnProperty("200")) {
      let p = Number(
        $(selector["200"])
          .text()
          .match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2,3})/)
      );

      price = {
        ...price,
        twoHundred: p,
      };
    }

    return price;
  }

  let p = Number(
    $(selector)
      .text()
      .match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2,3})/)
  );

  price = {
    ...price,
    oneHundred: p,
    oneFifty: p,
    twoHundred: p,
  };

  return price;
};

const scrape = async (site) => {
  try {
    var html = await getHtmlAxios(site.url);
  } catch (err) {
    site.error = err.message;
    failed.push(site);
    return;
  }

  try {
    var $ = cheerio.load(html);
  } catch (err) {
    site.error = err.message;
    failed.push(site);
    return;
  }

  try {
    var prices = extractPrices($, site.selector);
  } catch (err) {
    site.error = err.message;
    failed.push(site);
    return;
  }

  site.price = prices;

  await updateDatabase(site);
};

const queue = (concurrency = 4) => {
  let running = 0;
  const tasks = [];

  return {
    enqueue: async (task, ...params) => {
      tasks.push({ task, params });

      if (running >= concurrency) {
        return;
      }

      ++running;

      while (tasks.length) {
        const { task, params } = tasks.shift();
        await task(...params);
      }

      --running;

      if (tasks.length === 0 && running === 0) {
        console.log(
          `Done: ${success.length} successful, ${failed.length} failures. Sending email...`
        );
        emailFailed(failed);
      }
    },
  };
};

const scrapeTask = async (site) => {
  await scrape(site);
};

const updateDatabase = async (site) => {
  try {
    store
      .collection(process.env.FIRESTORE_COLLECTION)
      .doc(site.document_id)
      .update(
        {
          oneHundred: site.price.oneHundred,
          oneFifty: site.price.oneFifty,
          twoHundred: site.price.twoHundred,
          lastUpdated: fb.timestamp(),
        },
        { merge: true }
      );

    success.push(site);
  } catch (err) {
    site.error = err.message;
    failed.push(site);
  }
};

const getFormattedDate = () => {
  let date = new Date();
  let year = date.getFullYear();
  let month = (1 + date.getMonth()).toString().padStart(2, "0");
  let day = date.getDate().toString().padStart(2, "0");

  return month + "/" + day + "/" + year;
};

const emailFailed = async (failures) => {
  var transporter = nodemailer.createTransport({
    host: process.env.MAILTRAP_HOST,
    port: process.env.MAILTRAP_PORT,
    auth: {
      user: process.env.MAILTRAP_USER,
      pass: process.env.MAILTRAP_PASS,
    },
  });

  let handlebarOptions = {
    viewEngine: {
      partialsDir: path.resolve("./views/"),
      defaultLayout: false,
    },
    viewPath: path.resolve("./views/"),
  };

  transporter.use("compile", hbs(handlebarOptions));

  let mailerOptions = {
    from: process.env.MAIL_FAILURES_FROM,
    to: process.env.MAIL_FAILURES_TO,
    subject: `Price Scraping Report - ${getFormattedDate()}`,
    template: "email",
    context: {
      date: getFormattedDate(),
      year: new Date().getFullYear(),
      total: sites.length,
      successful: success.length,
      hasFailed: failures.length > 0,
      failed: failures,
    },
  };

  transporter.sendMail(mailerOptions, (err, info) => {
    if (!err)
      console.log(
        `Automated email has been sent. (${getFormattedDate()} - ${new Date().getHours()}:${new Date().getMinutes()})`
      );

    console.error(`An error occurred while sending the email: ${err.message}`);
  });
};

const q = queue();

sites.forEach((site) => {
  q.enqueue(scrapeTask, site);
});
